/**
 * Memory locality scopes — s234 (Layered channel/room memory scopes).
 *
 * Every memory carries a `scope` string on the LOCALITY axis (orthogonal to the
 * `entityId` "who" axis). Recall resolves a request's context into an ordered
 * **scope-stack** (most-specific → broadest); a memory is recallable iff its
 * scope is in that stack. That single rule yields both behaviours we want:
 *   - broader cascades DOWN  (gestalt/prime are in every stack)
 *   - narrow is CONFINED     (room:<P>:<R> is in no other stack — a DM secret
 *                             never leaks into another channel or a bare chat)
 *
 * Grammar (broad → specific):
 *   prime                          read-only built-in (aionima-prime); never written
 *   gestalt                        machine-wide shared substrate (Owner-governed)
 *   project:<projectPath>          per-project
 *   provider:<channelId>           per channel integration (discord, gmail, …)
 *   room:<channelId>:<roomId>      per room/thread/DM; roomId is free-form (may
 *                                  itself contain ':', e.g. "guild-1:channel-x")
 */

export type MemoryScope = string;

export type ScopeLayer = "prime" | "gestalt" | "project" | "provider" | "room";

export const SCOPE_PRIME = "prime";
export const SCOPE_GESTALT = "gestalt";

/** Layer ordering, broadest (0) → most-specific (4). */
export const SCOPE_LAYER_ORDER: Record<ScopeLayer, number> = {
  prime: 0,
  gestalt: 1,
  project: 2,
  provider: 3,
  room: 4,
};

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export function projectScope(projectPath: string): MemoryScope {
  return `project:${projectPath}`;
}

export function providerScope(channelId: string): MemoryScope {
  return `provider:${channelId}`;
}

export function roomScope(channelId: string, roomId: string): MemoryScope {
  return `room:${channelId}:${roomId}`;
}

// ---------------------------------------------------------------------------
// Parsing / classification
// ---------------------------------------------------------------------------

export interface ParsedScope {
  layer: ScopeLayer;
  projectPath?: string;
  channelId?: string;
  roomId?: string;
}

/**
 * Parse a scope string. Splits only on the FIRST ':' for the prefix so that
 * project paths and room ids may contain ':' freely.
 * Throws on an unrecognised prefix — scopes are produced by this module, an
 * unknown one signals a bug rather than untrusted input.
 */
export function parseScope(scope: MemoryScope): ParsedScope {
  if (scope === SCOPE_PRIME) return { layer: "prime" };
  if (scope === SCOPE_GESTALT) return { layer: "gestalt" };

  const i = scope.indexOf(":");
  if (i === -1) throw new Error(`Unrecognised memory scope: ${scope}`);
  const prefix = scope.slice(0, i);
  const rest = scope.slice(i + 1);

  switch (prefix) {
    case "project":
      return { layer: "project", projectPath: rest };
    case "provider":
      return { layer: "provider", channelId: rest };
    case "room": {
      const j = rest.indexOf(":");
      if (j === -1) throw new Error(`Malformed room scope (no roomId): ${scope}`);
      return {
        layer: "room",
        channelId: rest.slice(0, j),
        roomId: rest.slice(j + 1),
      };
    }
    default:
      throw new Error(`Unrecognised memory scope prefix: ${prefix}`);
  }
}

export function scopeLayer(scope: MemoryScope): ScopeLayer {
  return parseScope(scope).layer;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Context a recall/write request carries, drawn from channelContext + projectContext. */
export interface ScopeContext {
  /** Channel adapter id, e.g. "discord" (ChannelContextData.channelId). */
  channelId?: string | null;
  /** Room/thread id within the channel (ChannelContextData.roomId). */
  roomId?: string | null;
  /** Bound/active project path (AgentInvokeRequest.projectContext). */
  projectPath?: string | null;
}

/**
 * Resolve the ordered scope-stack for a recall context (most-specific →
 * broadest). `prime` and `gestalt` are always present; the channel/project
 * layers appear only when the context supplies them.
 *
 *   Discord room in a bound project → [room, provider, project, gestalt, prime]
 *   project chat (no channel)       → [project, gestalt, prime]
 *   bare/global chat                → [gestalt, prime]
 */
export function resolveScopeStack(ctx: ScopeContext): MemoryScope[] {
  const stack: MemoryScope[] = [];
  const channelId = ctx.channelId ?? undefined;
  const roomId = ctx.roomId ?? undefined;
  const projectPath = ctx.projectPath ?? undefined;

  if (channelId && roomId) stack.push(roomScope(channelId, roomId));
  if (channelId) stack.push(providerScope(channelId));
  if (projectPath) stack.push(projectScope(projectPath));
  stack.push(SCOPE_GESTALT);
  stack.push(SCOPE_PRIME);
  return stack;
}

/**
 * The single most-specific WRITABLE scope for a new memory. Never `prime`
 * (read-only) — channel turns confine to their room, otherwise project, else
 * the machine-wide gestalt floor.
 */
export function resolveWriteScope(ctx: ScopeContext): MemoryScope {
  const channelId = ctx.channelId ?? undefined;
  const roomId = ctx.roomId ?? undefined;
  const projectPath = ctx.projectPath ?? undefined;

  if (channelId && roomId) return roomScope(channelId, roomId);
  if (channelId) return providerScope(channelId);
  if (projectPath) return projectScope(projectPath);
  return SCOPE_GESTALT;
}

/** True for scopes the memory pipeline must never write to. */
export function isReadOnlyScope(scope: MemoryScope): boolean {
  return scopeLayer(scope) === "prime";
}

/**
 * Prompt-injection category label for a recalled memory, keyed off its scope
 * layer. Drives the per-locality headings in the system prompt's ## Memory
 * section. Unknown/legacy scopes fall back to the machine-wide "memory" bucket.
 */
export function memoryCategoryForScope(scope: MemoryScope | null | undefined): string {
  if (!scope) return "memory";
  let layer: ScopeLayer;
  try {
    layer = scopeLayer(scope);
  } catch {
    return "memory";
  }
  switch (layer) {
    case "room":
      return "room-memory";
    case "provider":
      return "channel-memory";
    case "project":
      return "project-memory";
    default:
      return "memory"; // gestalt | prime
  }
}
