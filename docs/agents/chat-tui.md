# Aion Chat TUI (`agi chat`): System Reference

`agi chat` is a terminal chat client for Aion itself — modeled closely on
Claude Code's own UX — not a specialized job/status browser. It reuses the
existing chat WebSocket protocol (the same one `ui/dashboard/src/components/
ChatFlyout.tsx` speaks), so it gets full owner-tier access: the same tool
registry, the same ability to dispatch and monitor Taskmaster through normal
conversation, no separate approve/reject screen.

## Container model

The folder `agi chat` is launched in (its `cwd` at invocation) is the **Chat
Container** — not a picker over `/api/projects`-registered projects. This
mirrors Claude Code directly: `cd` into any folder, run the chat client,
that folder is what you're chatting about.

This works because chat's `context` (the string carried on `chat:open` /
`chat:send`, `packages/gateway-core/src/server.ts`'s WS handler) was already
just a plain path with no registration requirement —
`ProjectConfigManager.read()` returns `null` (not a throw) for an
unregistered path, and `chatProjectPath` flows straight through to
`agentInvoker.process()` regardless. An arbitrary, never-registered folder
already worked end-to-end for chat before this ship; `agi chat` is simply the
first client built around that fact deliberately.

**CLI wrapper note**: `scripts/agi-cli.sh`'s `chat)` route has to `cd` into
the dev source tree to run the TS entrypoint, which would otherwise make
`process.cwd()` always resolve to that tree instead of wherever the user
actually ran `agi chat`. It captures `$PWD` into `AGI_CHAT_CALLER_CWD` before
the `cd`; `cli/src/commands/chat.ts` reads that env var as its container
path (falling back to plain `process.cwd()` for direct dev invocation, where
there's no `cd` in the way).

## `.agi` envelope awareness

If the container (or a nearby ancestor, searched up to 4 levels) is an `.agi`
envelope root — a directory with both `project.json` and an `.ai/`
subdirectory — the gateway folds its loop-state into the chat turn's system
prompt as context: `AGENTS.md`/`CLAUDE.md` content, plus a short headline
extracted from `.ai/plans/_next/checkpoint.mdc`'s YAML frontmatter
(`activeFocus`, `lastShipped.version`, `pendingQuestions`).

**This is pure context, never identity.** Aion's actual system prompt/persona
is assembled first and is never rewritten by project docs — see
`assembleSystemPromptWithBreakdown` in `packages/gateway-core/src/
system-prompt.ts`, which pushes PRIME/persona content first and only ever
*appends* project-derived sections afterward. The relevant functions:

- `buildProjectContextSection(projectPath, notes)` — the per-turn function
  already gated only on `ctx.projectPath !== undefined` (no dev-mode
  requirement, unlike the older `buildWorkspaceContextSection`/`devMode`
  path). Extended this ship to also call:
  - `readProjectInstructionsExcerpt(projectPath)` — reads `AGENTS.md`
    (preferred) or `CLAUDE.md` (fallback — many repos symlink one to the
    other), truncated to 500 chars.
  - `readAgiEnvelopeContext(projectPath)` — the envelope walk-up +
    checkpoint.mdc summary described above.

Because this hangs off the SAME per-turn `projectPath`-gated code path the
dashboard's own project-scoped chat already uses, both clients get this
context identically — there was no need to add a new per-client flag or
touch the pre-existing `devMode`/`buildWorkspaceContextSection` gate at all.

## On-demand `.mcp.json` loading

Chat's own tool loop reaches MCP servers today via a generic `mcp` tool
(`server.ts` ~3008-3062, proxying to the shared `McpClient`) — the LLM calls
it with `action=call/list-servers/list-tools`. That part was already true for
any *registered* project (its `.mcp.json` gets swept into `McpClient` at
gateway boot, namespaced `<projectSlug>:<serverId>`).

An ad hoc Chat TUI container usually isn't a registered project, so it was
never part of that boot-time sweep. `server.ts`'s `chat:open` handler now
calls `ensureProjectMcpRegistered(fullPath, label)` — the exact same
`.mcp.json`-reading logic the boot sweep uses, extracted into a reusable
function — for any `context` that looks like a real, existing folder path
(not `"general"`/`"builder:"`/`"mapp:"`/`"help:"`). This means a Chat TUI
container's own `.mcp.json` (Claude Code's own convention — no
`project.json` requirement at all for this on-demand path, unlike the
boot-sweep call site which still requires `project.json` to preserve its
original behavior) gets registered the moment you open a chat session there,
so the `mcp` tool can reach it in that same conversation.

Registration is idempotent (`McpClient.registerServer` id-keys by
`<projectSlug>:<serverId>`) and non-fatal — a chat session still opens even
if `.mcp.json` registration fails for some reason.

## Protocol

`packages/gateway-core/src/chat-ws-types.ts` documents the wire shapes
(`ChatClientMessage`/`ChatServerMessage`) that `server.ts`'s WS handler has
always implemented ad hoc as string-literal `case`s — purely additive typing
for `cli/src/chat-client.ts` to import; it does not change `server.ts`'s
actual handler logic. Covers the subset a plain chat client needs
(`chat:open`/`send`/`cancel`/`close` in; `chat:opened`/`thinking`/
`tool_start`/`tool_result`/`progress`/`thought`/`response`/`error`/
`cancelled`/`closed` out) — dashboard-only messages (plan approve/reject,
inject, history, suggestions) are out of scope.

`cli/src/chat-client.ts`'s `ChatClient` connects to `ws://<host>:<port>/ws`
using Node's built-in global `WebSocket` (stable since Node 22; this repo
requires `>=22.12.0` — no new dependency). No auth token is needed for a
localhost connection: `ws-server.ts`'s `verifyClient` auto-allows any
private-network IP (loopback included) before it ever checks for a token.

**A turn never hangs forever.** `ChatClient.send()` takes a `sendTimeoutMs`
option (default 120s, `agi chat --timeout <seconds>`) — if no terminal event
(`chat:response`/`chat:error`/`chat:cancelled`) arrives in time, it rejects
locally with `ChatTimeoutError` and fires a best-effort `chat:cancel` (not
awaited). `cancel()` also rejects the in-flight turn's promise immediately,
client-side, rather than waiting for the server's `chat:cancelled` echo —
that round-trip can itself hang if the server is genuinely stuck. This
matters because a real (2026-07-16) production hang surfaced exactly this
gap: a turn stuck at `chat:thinking` with no further events, and Ctrl-C
didn't recover it either (through whatever terminal layer was in front of
the process at the time). Without a client-side timeout, there was no way
out short of killing the terminal.

**`--debug <path>`** streams every `ChatClient` event — outbound WS sends,
inbound frames (parsed, or a `parse-error` event if a frame isn't valid
JSON), and connection-lifecycle events (`ws:connecting`/`ws:open`/
`ws:error`/`ws:close`, `send:timeout`, `cancel()`) — as JSONL to the given
file via `ChatClientOptions.debugSink`. This only covers the client's own
view of the wire; a turn that hangs *server-side* (no response ever sent)
needs `agi logs` on the gateway, which this flag can't see — a real
2026-07-19 incident (the same class of hang the timeout above guards
against) turned out to be exactly that: `AnthropicProvider`'s retry loop had
no logging at all, so a stuck turn looked identical to a genuinely
in-progress one from the logs. See `packages/gateway-core/src/llm/
anthropic-provider.ts`'s `invoke()` for the server-side fix —
request-lifecycle logging plus disabling the Anthropic SDK's own redundant
internal retry layer (which compounded on top of the provider's own retry
loop with nothing logged in between).

## Rendering: full-window layout on `@particle-academy/fancy-tui`

`agi chat`'s interactive UI (`cli/src/chat-tui/App.tsx`) is a full-window Ink
app built entirely on `@particle-academy/fancy-tui` — the terminal/Ink
counterpart to the Fancy UI kit already used throughout the dashboard. No
custom Ink components were written for this: the library already provides
everything a Claude-Code-style chat surface needs.

- **`chat.ts`'s `runInkChat` takes over the terminal's alternate screen
  buffer** (`\x1b[?1049h` on start, `\x1b[?1049l` on exit, the same mechanism
  vim/htop/less use) so `agi chat` starts from a blank canvas exactly the
  size of the terminal — like Claude Code — rather than printing inline
  wherever the shell cursor happened to be. The prior shell scrollback is
  preserved underneath and reappears untouched on exit. Ink's `render()` has
  no notion of this on its own; it's applied imperatively around `render()`/
  `waitUntilExit()` in a `try/finally`, gated on `process.stdout.isTTY`.
- **`useChatSession.ts`** (`cli/src/chat-tui/useChatSession.ts`) is the only
  file that touches `ChatClient` directly — it translates the client's
  callback-based events (`onThinking`/`onToolStart`/`onToolResult`/
  `onProgress`/`onThought`/`onUnsolicitedResponse`) into React state shaped
  for the library's components: `messages: MessageData[]` (committed
  scrollback — user/agent/tool/error entries), `thinking`/`statusText` (the
  current turn's live status), `liveToolCalls: ToolCallData[]` (in-flight
  tool calls, folded into `messages` once each resolves).
- **`App.tsx`** composes `FancyTuiProvider` → `Screen` → `Header` (container
  path + connection status) → a message list (scrollback, backed by Ink
  `Static` inside the library) → `LiveRegion` (thinking spinner + in-flight
  `ToolCall` rows, hidden entirely under `--quiet`) → `Composer` (the
  multi-line input box) → `StatusBar` (key hints, `.agi` envelope badge).
  The message list composes `StaticList` + `Message` directly (both public
  exports) instead of `fancy-tui`'s own `<MessageList>`, which renders
  entries back-to-back with zero gap and exposes no spacing prop — wrapping
  each `Message` in a `Box marginBottom={1}` adds the blank line between
  entries that `<MessageList>` doesn't.
- **Multi-line composition and its terminal-support caveat are handled by the
  library, not this codebase.** `Composer` submits on Enter and inserts a
  newline on Alt+Enter (works on every terminal) or Shift+Enter (only when
  the terminal reports "enhanced keyboard" support — most terminals send an
  identical byte sequence for Enter and Shift+Enter without it). Query
  `useFancyTui().capabilities.shiftEnter` to check a given terminal's actual
  support rather than assuming — `App.tsx` shows an "Alt+Enter: newline" key
  hint in the status bar specifically when `shiftEnter` is `false`.
- **`Composer` does not auto-focus itself.** It calls Ink's own `useFocus()`
  internally without `autoFocus: true` (Ink's default), so nothing is
  focused until something calls the focus manager explicitly — otherwise the
  box renders with a single border and every keystroke is silently dropped
  (confirmed by isolating a bare `<Composer>` outside `App.tsx` entirely:
  `useInput` fired correctly, but `isFocused` never went `true`). `App.tsx`
  calls Ink's own `useFocusManager().focus("prompt")` in a mount effect to
  claim focus for the Composer explicitly.
- **Non-TTY fallback is a hard requirement, not a nicety.** Ink cannot render
  a full-screen layout without a real terminal. `chat.ts` checks
  `process.stdin.isTTY` and runs the *original* plain-text `readline` REPL
  (`runReadlineChat`) for piped/non-interactive invocation — the same
  `ChatClient`, same timeout/cancel behavior, just printed output instead of
  a rendered layout. `runInkChat` (the `fancy-tui` path) is the default only
  when stdin is a real TTY.

## Scope of this ship

- **Workspace-scoped session resume.** `registerChatCommand` calls the
  existing `GET /api/chat/sessions` (via `GatewayClient.chatSessions()`)
  before opening the WS connection, filters to sessions whose `context`
  matches the resolved container path, and auto-picks the most recently
  updated one as `resumeSessionId` — passed to `ChatClient.open(context,
  sessionId)`, which already supported resuming (unchanged). `useChatSession`
  hydrates the resumed session's prior `messages` into the transcript on
  `chat:opened` via a new `historyLoaded` reducer action.  `--session <id>`
  overrides the auto-pick explicitly; `--new-session` forces a fresh session
  even when a prior one exists. A gateway that's unreachable or too old to
  have this endpoint just falls through to a fresh session — the failure
  mode is silent-and-safe, not a hard error. Still single active session
  *per running `agi chat` process* — switching between multiple saved
  sessions from inside a running session (not just at launch) remains a
  fast-follow.
- **Slash-command palette.** `Composer` input starting with `/` renders
  `fancy-tui`'s `Command` above the input, filtered live — but selection
  itself is driven by `App.tsx`'s own exact-match-on-Enter logic, not
  `Command`'s internal `Button` focus/press handling, to avoid a
  focus-contention problem: `Command`'s buttons and the `Composer` can't
  usefully hold focus at the same time, and forcing the user to `Tab` into
  the list to select would break the type-to-filter-then-Enter flow this is
  meant to match (Claude Code's own slash-command UX). `Command` is used
  purely for its visual rendering here. Known commands: `/quit`, `/exit`,
  `/clear` (empties the visible scrollback — local only, the server's saved
  history is untouched), `/help` (lists commands via a dismissible
  `Callout`, not injected into the persisted transcript).
- **Mushroom persona glyph.** Agent-role messages render a `fancy-tui`
  `Avatar` (glyph `🍄`) alongside `Message` in `App.tsx`'s `StaticList`
  render — `Message` itself is sealed with no avatar slot, so this is a
  sibling in the same `Row`, not something injected inside it. `🍄` is the
  practical fallback for Aion's actual brand mark
  (`ui/dashboard/public/spore-seed-clear.svg`) — a terminal can't render
  SVG/vector art at all, so an emoji is the only option; mushroom fits the
  mycelium/spore branding already present in Aion's own voice.
- **First-pass 0REALTALK reader** (`cli/src/chat-tui/realtalk-reader.ts`).
  PRIME documents 0REALTALK as a "SYNAPTIC Programming Language" with a
  layered PACK/UNPACK design, but every corpus file describing it is
  explicitly WIP/MUSING status and states outright there's "no formal
  compiler/interpreter" yet. This is deliberately Phase 1 only, matching
  the corpus's own scoping (`evolution/musings/0realtalk-engine.md`):
  *"0READER parses known patterns from lexicon... Validation = lexicon
  membership."* `parseRealtalk()` is a pure, side-effect-free recognizer
  against `core/0TERMS.md`'s LAW-status lexicon (32 terms, confidence ≥
  0.9) and `core/0ACCESSOR.md`'s `<FRAME>STATION>ROLE` accessor grammar
  (packed abbreviations follow the corpus's own shortest-unique-prefix
  convention, e.g. `Op`/`Ob` for OPERATOR/OBSERVER — not invented). It
  recognizes accessors, `|+value|` confidence notation, `:seg:seg:` impact
  marks, `+$imp`/`-$imp` boon/burn, and known LAW terms, and decodes each
  into a human-readable summary shown live in a `Callout` above the
  Composer (mutually exclusive with the slash-command palette) — purely
  informational, exactly like the confidence-preview it is. It does **not**
  execute anything, validate alignment, or touch the corpus's own
  still-open questions (what runs compiled 0REALTALK, whether it's "the
  language of SENTIENCE") — those stay unresolved on purpose. What actually
  gets sent to Aion is unchanged; this only decodes for the human typing it.
- No real token-by-token streaming — `chat:response` delivers the full
  answer in one frame (the gateway's `AnthropicClient` call is
  non-streaming today), same as the dashboard. Tool activity/thinking/
  progress events (rendered live via `LiveRegion`/`Spinner`/`ToolCall`) are
  what make a turn feel live.
- `.agi` envelope awareness is detection + context only. Actual
  Claude-Code-style hook *execution* (SessionStart/Stop-equivalent hooks)
  is explicitly out of scope for this pass.
