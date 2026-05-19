/// <reference lib="dom" />
/**
 * ScriptRunner — Phase A WASM host infrastructure.
 *
 * Executes a pre-compiled WASM module with JSON input/output, wall-clock
 * timing, SHA-256 COA logging, and WASI stubs that enforce deterministic mode
 * (frozen clock + seeded PRNG). Full WASI preopens and stdout capture arrive
 * in Phase D when the Starlark-to-WASM pipeline is wired.
 *
 * Phase A limitations:
 * - Synchronous execution (blocks event loop for script duration).
 *   Worker-thread isolation lands in Phase D for runaway protection.
 * - WASI preopens option is reserved; path_open returns EBADF in Phase A.
 * - Output is read from memory offset 65536 (page boundary) — the WASM
 *   module must null-terminate a JSON string there. Modules that don't
 *   write output return `{}`.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ScriptExitReason = "ok" | "timeout" | "oom" | "error";

export interface ScriptOptions {
  /**
   * Wall-clock timeout in ms. Reserved for Phase D Worker isolation.
   * Phase A WASM must self-terminate within this budget.
   * @default 1000
   */
  timeoutMs?: number;
  /**
   * Max linear memory pages (64 KB each).
   * @default 256  (16 MB)
   */
  maxMemoryPages?: number;
  /**
   * WASI preopens: guestPath → hostPath.
   * Reserved for Phase D; path_open returns EBADF in Phase A.
   */
  preopens?: Record<string, string>;
  /**
   * Freeze clock at epoch and seed PRNG for reproducible packer execution.
   * 0REALTALK packers MUST use deterministic mode.
   * @default true
   */
  deterministic?: boolean;
  /**
   * PRNG seed used when `deterministic: true`.
   * @default 0
   */
  seed?: number;
}

export interface ScriptResult {
  /** Parsed JSON output from the script. `{}` when the module wrote no output. */
  output: unknown;
  /** Raw null-terminated string read from WASM linear memory at offset 65536. */
  stdout: string;
  /** Exit code (0 = success). Set from `proc_exit` if called, else 0. */
  exitCode: number;
  /** Actual wall-clock duration. */
  durationMs: number;
  /** `sha256:<hex>` hash of `JSON.stringify(input)`. */
  inputHash: string;
  /** `sha256:<hex>` hash of captured stdout. */
  outputHash: string;
  /** Reason the invocation stopped. */
  exitReason: ScriptExitReason;
}

export class ScriptError extends Error {
  constructor(
    message: string,
    public readonly exitReason: Exclude<ScriptExitReason, "ok">,
    public readonly durationMs: number,
    public readonly inputHash: string,
  ) {
    super(message);
    this.name = "ScriptError";
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export class ScriptRunner {
  /**
   * Execute a WASM binary with the given JSON input and return a ScriptResult.
   *
   * The module may import from `wasi_snapshot_preview1`; all syscalls are
   * stubbed. `proc_exit` is handled: exit code 0 → `exitReason: "ok"`,
   * non-zero → `exitReason: "error"`.
   */
  async run(
    wasmBinary: Uint8Array,
    input: unknown = null,
    opts: ScriptOptions = {},
  ): Promise<ScriptResult> {
    const { maxMemoryPages = 256 } = opts;

    const startMs = Date.now();
    const inputJson = JSON.stringify(input);
    const inputHash = sha256(inputJson);

    let stdout = "";
    let exitCode = 0;
    let exitReason: ScriptExitReason = "ok";

    // 2 initial pages (128 KB): page 0 = input scratch, page 1 = output area at offset 65536.
    const memory = new WebAssembly.Memory({ initial: 2, maximum: maxMemoryPages });

    try {
      const importObject: WebAssembly.Imports = {
        env: { memory },
        wasi_snapshot_preview1: buildWasiStubs(memory, opts),
      };

      // Pass the Uint8Array directly — do NOT use .buffer, which may have a non-zero
      // byte offset if the view is a slice of a larger SharedArrayBuffer.
      // Double assertion through unknown: overlapping DOM + @types/node overloads cause
      // TypeScript to select the Module→Instance overload; this restores BufferSource→Source.
      const { instance } = (await WebAssembly.instantiate(wasmBinary, importObject)) as unknown as WebAssembly.WebAssemblyInstantiatedSource;

      // Write input JSON at offset 0 of linear memory (page 0 = runtime scratch).
      const inputBytes = new TextEncoder().encode(inputJson);
      new Uint8Array(memory.buffer).set(inputBytes, 0);

      // Execute the module's entry point.
      if (typeof instance.exports["_start"] === "function") {
        (instance.exports["_start"] as () => void)();
      }

      // Read output from offset 65536 (start of page 2). The WASM module
      // writes a null-terminated JSON string there; absent output → "{}".
      stdout = readNullTerminated(memory.buffer, 65536) || "{}";

    } catch (err) {
      const wasiExit = asWasiExit(err);
      if (wasiExit !== null) {
        exitCode = wasiExit;
        exitReason = wasiExit === 0 ? "ok" : "error";
        // Re-read output — proc_exit may be called after writing output.
        stdout = readNullTerminated(memory.buffer, 65536) || "{}";
      } else {
        exitCode = 1;
        exitReason = "error";
        stdout = JSON.stringify({ error: String(err) });
      }
    }

    const durationMs = Date.now() - startMs;
    const outputHash = sha256(stdout);

    let output: unknown = null;
    try { output = JSON.parse(stdout); } catch { output = stdout; }

    return { output, stdout, exitCode, durationMs, inputHash, outputHash, exitReason };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sha256(data: string): string {
  return "sha256:" + createHash("sha256").update(data).digest("hex");
}

function readNullTerminated(buffer: ArrayBuffer, offset: number): string {
  const view = new Uint8Array(buffer, offset);
  const end = view.indexOf(0);
  const slice = end === -1 ? view : view.slice(0, end);
  return new TextDecoder().decode(slice);
}

/** Extract exit code from a proc_exit throw, or return null for other errors. */
function asWasiExit(err: unknown): number | null {
  if (err instanceof Error && "wasiExitCode" in err) {
    return (err as Error & { wasiExitCode: number }).wasiExitCode;
  }
  return null;
}

/**
 * Stub WASI imports for the Phase A host.
 *
 * - `proc_exit` throws a tagged error so the caller can recover the exit code.
 * - `clock_time_get` returns frozen epoch in deterministic mode.
 * - `random_get` returns a seeded stream in deterministic mode.
 * - All other syscalls return success (0) or EBADF (8) as appropriate.
 */
function buildWasiStubs(
  memory: WebAssembly.Memory,
  opts: ScriptOptions,
): Record<string, WebAssembly.ImportValue> {
  const { deterministic = true, seed = 0 } = opts;

  return {
    proc_exit: (code: number) => {
      const err = Object.assign(new Error(`wasi:proc_exit(${code})`), { wasiExitCode: code });
      throw err;
    },

    fd_write: (fd: number, iovs: number, iovsLen: number, nwrittenPtr: number): number => {
      // Phase A: writes are no-ops; Phase D will capture stdout (fd=1).
      const view = new DataView(memory.buffer);
      view.setUint32(nwrittenPtr, 0, true);
      return 0;
      void fd; void iovs; void iovsLen;
    },

    fd_read: (): number => 8, // EBADF

    fd_close: (): number => 0,

    clock_time_get: (
      _clockId: number,
      _precision: bigint,
      timestampPtr: number,
    ): number => {
      const ns = deterministic ? 0n : BigInt(Date.now()) * 1_000_000n;
      new DataView(memory.buffer).setBigUint64(timestampPtr, ns, true);
      return 0;
    },

    random_get: (bufPtr: number, bufLen: number): number => {
      const buf = new Uint8Array(memory.buffer, bufPtr, bufLen);
      if (deterministic) {
        // Linear congruential generator seeded deterministically.
        let s = seed >>> 0;
        for (let i = 0; i < bufLen; i++) {
          s = Math.imul(s, 1103515245) + 12345;
          buf[i] = (s >>> 16) & 0xff;
        }
      } else {
        crypto.getRandomValues(buf);
      }
      return 0;
    },

    path_open: (): number => 8, // EBADF — Phase D adds preopens

    environ_get: (): number => 0,

    environ_sizes_get: (countPtr: number, sizesPtr: number): number => {
      const view = new DataView(memory.buffer);
      view.setUint32(countPtr, 0, true);
      view.setUint32(sizesPtr, 0, true);
      return 0;
    },

    args_get: (): number => 0,

    args_sizes_get: (argcPtr: number, argvBufSizePtr: number): number => {
      const view = new DataView(memory.buffer);
      view.setUint32(argcPtr, 0, true);
      view.setUint32(argvBufSizePtr, 0, true);
      return 0;
    },
  };
}
