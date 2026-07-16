/**
 * `agi chat` — interactive terminal chat with Aion.
 *
 * Modeled on Claude Code itself: the folder the command is launched in is
 * the "Chat Container" (not a picker over registered `/api/projects`),
 * full owner-tier access (same as the dashboard's chat), and — if the
 * container is (or sits inside) an `.agi` envelope — the server folds in
 * that envelope's loop-state as context. See `docs/agents/chat-tui.md`.
 */

import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { ChatClient, ChatWsUnreachableError, ChatTurnError, type ChatToolStartEvent, type ChatToolResultEvent } from "../chat-client.js";
import { bold, dim, red } from "../output.js";

/** How many parent directories to check for an `.agi` envelope root — mirrors gateway-core's own readAgiEnvelopeContext search depth. Purely cosmetic here (a startup banner); the gateway does its own detection for system-prompt context. */
const AGI_ENVELOPE_SEARCH_DEPTH = 4;

export function detectAgiEnvelope(startPath: string): string | null {
  let dir = startPath;
  for (let i = 0; i < AGI_ENVELOPE_SEARCH_DEPTH; i++) {
    try {
      if (statSync(join(dir, "project.json")).isFile() && statSync(join(dir, ".ai")).isDirectory()) {
        return dir;
      }
    } catch {
      // not an envelope root — keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function registerChatCommand(program: Command): void {
  program
    .command("chat")
    .description("Interactive chat with Aion — full owner-tier access, scoped to the current folder")
    .option("--cwd <path>", "Container folder (defaults to the current directory)")
    .action(async (cmdOpts: { cwd?: string }) => {
      const opts = program.opts<{ host?: string; port?: number }>();
      // scripts/agi-cli.sh's `chat` route `cd`s into the dev source tree
      // before exec-ing this file, so `process.cwd()` alone would always
      // resolve to that tree rather than wherever the user actually ran
      // `agi chat` — it sets AGI_CHAT_CALLER_CWD beforehand to preserve
      // the real caller directory. Direct dev invocation (no wrapper) has
      // no `cd`, so plain `process.cwd()` is already correct there.
      const containerPath = cmdOpts.cwd
        ? resolve(cmdOpts.cwd)
        : (process.env.AGI_CHAT_CALLER_CWD ?? process.cwd());

      if (!existsSync(containerPath)) {
        console.error(red(`Container folder does not exist: ${containerPath}`));
        process.exitCode = 1;
        process.exit(1);
      }

      const envelopeRoot = detectAgiEnvelope(containerPath);

      console.log();
      console.log(`${bold("agi chat")} ${dim(`— ${containerPath}`)}`);
      if (envelopeRoot !== null) {
        console.log(dim(`.agi envelope detected at ${envelopeRoot}`));
      }
      console.log(dim("/quit or Ctrl-C to exit"));
      console.log();

      const client = new ChatClient({ host: opts.host ?? "127.0.0.1", port: opts.port ?? 3100 });
      client.on({
        onThinking: () => process.stdout.write(dim("  …thinking\n")),
        onToolStart: (e: ChatToolStartEvent) => process.stdout.write(dim(`  → ${e.toolName}\n`)),
        onToolResult: (e: ChatToolResultEvent) => process.stdout.write(dim(`  ${e.success ? "✓" : "✗"} ${e.toolName}: ${e.summary}\n`)),
        onProgress: (e) => process.stdout.write(dim(`  ${e.text}\n`)),
        onThought: (content) => process.stdout.write(dim(`  ${content.length > 200 ? `${content.slice(0, 200)}…` : content}\n`)),
        onUnsolicitedResponse: (text) => process.stdout.write(`\n${bold("Aion:")} ${text}\n\n`),
        onClosed: () => console.log(dim("\nConnection closed.")),
      });

      try {
        await client.open(containerPath);
      } catch (err) {
        if (err instanceof ChatWsUnreachableError) {
          console.error(red(err.message));
        } else {
          console.error(red(err instanceof Error ? err.message : String(err)));
        }
        process.exitCode = 1;
        process.exit(1);
      }

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      let exiting = false;
      const onSigint = () => {
        if (exiting) return;
        exiting = true;
        client.cancel();
        rl.close();
      };
      process.on("SIGINT", onSigint);

      try {
        while (!exiting) {
          let line: string;
          try {
            line = await rl.question("> ");
          } catch {
            break; // EOF / Ctrl-D / Ctrl-C during the prompt itself
          }
          const trimmed = line.trim();
          if (trimmed === "") continue;
          if (trimmed === "/quit" || trimmed === "/exit") break;

          try {
            const text = await client.send(trimmed);
            console.log();
            console.log(`${bold("Aion:")} ${text}`);
            console.log();
          } catch (err) {
            if (err instanceof ChatTurnError) {
              console.log(red(`Error: ${err.message}`));
            } else {
              console.log(red(err instanceof Error ? err.message : String(err)));
            }
          }
        }
      } finally {
        process.removeListener("SIGINT", onSigint);
        rl.close();
        client.close();
        // See taskmaster.ts's comment — a persistent connection anywhere in
        // this process (WS here, fetch() there) leaves the event loop alive
        // after the REPL genuinely exits. Exit explicitly.
        process.exit(process.exitCode ?? 0);
      }
    });
}
