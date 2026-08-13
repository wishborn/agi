/**
 * System-prompt prefix-cache tests — task #804.
 *
 * The load-bearing invariant: turning the assembled system prompt into
 * cache-aware blocks must NOT change the effective prompt by a single byte —
 * otherwise the model sees a different prompt AND the cache never hits. Every
 * test here defends that, plus the cache-breakpoint placement and the
 * builder/help-mode prepend fallback (where the identity block is no longer the
 * prefix, so caching must safely turn itself off).
 */

import { describe, it, expect } from "vitest";

import { systemToText } from "./llm/types.js";
import type { LLMSystemBlock } from "./llm/types.js";
import { toAnthropicSystem } from "./llm/anthropic-provider.js";
import {
  buildSystemWithCache,
  assembleSystemPromptWithBreakdown,
} from "./system-prompt.js";
import type { SystemPromptContext } from "./system-prompt.js";

// ---------------------------------------------------------------------------
// systemToText — provider-agnostic flattening
// ---------------------------------------------------------------------------

describe("systemToText", () => {
  it("passes a plain string through unchanged", () => {
    expect(systemToText("hello world")).toBe("hello world");
  });

  it("joins blocks with NO separator (blocks carry their own whitespace)", () => {
    const blocks: LLMSystemBlock[] = [
      { text: "IDENTITY\n\n", cache: true },
      { text: "TOOLS", cache: false },
    ];
    expect(systemToText(blocks)).toBe("IDENTITY\n\nTOOLS");
  });
});

// ---------------------------------------------------------------------------
// buildSystemWithCache — the split
// ---------------------------------------------------------------------------

describe("buildSystemWithCache", () => {
  const identity = "You are Aionima, an ancient wise being.";
  const rest = "Available tools: none.\n\nOperational state: ONLINE";
  const full = `${identity}\n\n${rest}`;

  it("splits into a cached head + dynamic remainder", () => {
    const result = buildSystemWithCache(full, identity);
    expect(Array.isArray(result)).toBe(true);
    const blocks = result as LLMSystemBlock[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ text: `${identity}\n\n`, cache: true });
    expect(blocks[1]).toEqual({ text: rest, cache: false });
  });

  it("INVARIANT: flattened blocks are byte-identical to the original prompt", () => {
    const result = buildSystemWithCache(full, identity);
    expect(systemToText(result)).toBe(full);
  });

  it("marks exactly one cache breakpoint, on the head", () => {
    const blocks = buildSystemWithCache(full, identity) as LLMSystemBlock[];
    expect(blocks.filter((b) => b.cache === true)).toHaveLength(1);
    expect(blocks[0]!.cache).toBe(true);
  });

  it("returns a plain string (no caching) when the prefix is empty", () => {
    expect(buildSystemWithCache(full, "")).toBe(full);
  });

  it("returns a plain string when the prompt does NOT start with the prefix (builder/help prepend)", () => {
    // Builder/help mode prepends its own prompt, so identity is mid-prompt.
    const prepended = `BUILDER PROMPT\n\n---\n\n${full}`;
    const result = buildSystemWithCache(prepended, identity);
    expect(result).toBe(prepended); // unchanged string, cache safely disabled
    expect(systemToText(result)).toBe(prepended);
  });

  it("returns a plain string when there is no remainder after the prefix", () => {
    expect(buildSystemWithCache(identity, identity)).toBe(identity);
  });
});

// ---------------------------------------------------------------------------
// toAnthropicSystem — mapping to the Anthropic system field
// ---------------------------------------------------------------------------

describe("toAnthropicSystem", () => {
  it("passes a plain string through unchanged", () => {
    expect(toAnthropicSystem("just a string")).toBe("just a string");
  });

  it("maps blocks to text content blocks with cache_control only on cached blocks", () => {
    const blocks: LLMSystemBlock[] = [
      { text: "IDENTITY\n\n", cache: true },
      { text: "TOOLS", cache: false },
    ];
    const result = toAnthropicSystem(blocks);
    expect(result).toEqual([
      { type: "text", text: "IDENTITY\n\n", cache_control: { type: "ephemeral" } },
      { type: "text", text: "TOOLS" },
    ]);
  });

  it("drops empty-text blocks so the SDK never sees a zero-length block", () => {
    const blocks: LLMSystemBlock[] = [
      { text: "", cache: true },
      { text: "REAL", cache: false },
    ];
    const result = toAnthropicSystem(blocks) as { text: string }[];
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe("REAL");
  });

  it("end-to-end: split → map yields ONE breakpoint and reconstructs the prompt", () => {
    const identity = "PERSONA BLOCK";
    const full = `${identity}\n\nDYNAMIC TAIL`;
    const mapped = toAnthropicSystem(buildSystemWithCache(full, identity)) as {
      text: string;
      cache_control?: unknown;
    }[];
    expect(mapped.filter((b) => b.cache_control !== undefined)).toHaveLength(1);
    expect(mapped.map((b) => b.text).join("")).toBe(full);
  });
});

// ---------------------------------------------------------------------------
// assembleSystemPromptWithBreakdown — identityPrefix is the true prefix
// ---------------------------------------------------------------------------

describe("assembleSystemPromptWithBreakdown identityPrefix", () => {
  const baseCtx: SystemPromptContext = {
    entity: {
      entityId: "e1",
      coaAlias: "#E0",
      displayName: "Owner",
      verificationTier: "verified",
      channel: "chat",
    },
    coaFingerprint: "fp",
    state: "ONLINE",
    capabilities: { canInvoke: true, canUseTools: true, canDispatchWorkers: true } as never,
    tools: [],
  };

  it("returns an identityPrefix that the assembled prompt starts with", () => {
    const { prompt, identityPrefix } = assembleSystemPromptWithBreakdown(baseCtx);
    expect(identityPrefix.length).toBeGreaterThan(0);
    expect(prompt.startsWith(identityPrefix)).toBe(true);
  });

  it("wiring: buildSystemWithCache(prompt, identityPrefix) round-trips to the prompt", () => {
    const { prompt, identityPrefix } = assembleSystemPromptWithBreakdown(baseCtx);
    expect(systemToText(buildSystemWithCache(prompt, identityPrefix))).toBe(prompt);
  });
});
