/**
 * `agi chat`'s full-window layout — composed entirely from
 * `@particle-academy/fancy-tui` primitives (see `docs/agents/chat-tui.md`).
 * No custom Ink components are written here; this file only wires
 * `useChatSession`'s state into the library's own components.
 */

import { useApp, useFocusManager, useInput } from "ink";
import { useEffect, useState } from "react";
import {
  FancyTuiProvider,
  Screen,
  Header,
  StaticList,
  Message,
  Box,
  Avatar,
  LiveRegion,
  Spinner,
  ToolCall,
  Composer,
  Command,
  Row,
  Text,
  StatusBar,
  KeyHint,
  Badge,
  Callout,
  useFancyTui,
  type Option,
} from "@particle-academy/fancy-tui";
import { useChatSession } from "./useChatSession.js";
import { parseRealtalk } from "./realtalk-reader.js";
import type { ChatClientOptions } from "../chat-client.js";

/** Known `/`-prefixed commands — deliberately small; extend here as new ones earn a slot. */
const SLASH_COMMANDS: Option[] = [
  { id: "/quit", label: "/quit", description: "Exit agi chat" },
  { id: "/exit", label: "/exit", description: "Exit agi chat (alias for /quit)" },
  { id: "/clear", label: "/clear", description: "Clear the visible conversation — local only, the server's saved history is untouched" },
  { id: "/help", label: "/help", description: "List available commands" },
];

export interface AppProps {
  containerPath: string;
  envelopeRoot: string | null;
  chatClientOptions: ChatClientOptions;
  /** Suppress the live thinking/tool-activity region — just committed messages. */
  quiet?: boolean;
  /** A saved session to resume — its history hydrates into the transcript on open. */
  resumeSessionId?: string;
}

function ConnectedApp({ containerPath, envelopeRoot, chatClientOptions, quiet = false, resumeSessionId }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const { focus } = useFocusManager();
  const { capabilities } = useFancyTui();
  const [draft, setDraft] = useState("");
  const [showHelp, setShowHelp] = useState(false);

  // fancy-tui's Composer calls Ink's useFocus() without autoFocus — nothing
  // is focused by default (the user would otherwise have to press Tab first).
  useEffect(() => {
    focus("prompt");
  }, [focus]);
  const {
    messages,
    thinking,
    statusText,
    liveToolCalls,
    connectionState,
    connectionError,
    sessionId,
    send,
    cancel,
    clearMessages,
  } = useChatSession(containerPath, { ...chatClientOptions, resumeSessionId });

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (thinking) {
        cancel();
      } else {
        exit();
      }
    }
  });

  const trimmedDraft = draft.trim();
  const isComposingCommand = trimmedDraft.startsWith("/");
  const commandQuery = isComposingCommand ? trimmedDraft.slice(1) : "";
  // Decoded live, never alters what actually gets sent — a first-pass
  // 0READER (repos/prime/core/0TERMS.md + 0ACCESSOR.md), Phase 1 scope only
  // (recognize known lexicon patterns, decode for the human typing them).
  // Mutually exclusive with the slash-command palette so they never overlap.
  const realtalkMatch = isComposingCommand ? null : parseRealtalk(trimmedDraft);

  const handleDraftChange = (value: string): void => {
    setDraft(value);
    if (showHelp) setShowHelp(false);
  };

  const runSlashCommand = (id: string): void => {
    switch (id) {
      case "/quit":
      case "/exit":
        exit();
        return;
      case "/clear":
        clearMessages();
        return;
      case "/help":
        setShowHelp(true);
        return;
      default:
        return;
    }
  };

  const handleSubmit = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed === "") return;
    if (trimmed.startsWith("/")) {
      // Exact match only — an ambiguous/partial slash command (e.g. just
      // "/" or "/qu") leaves the palette open below instead of guessing.
      const match = SLASH_COMMANDS.find((c) => c.id === trimmed.toLowerCase());
      if (!match) return;
      setDraft("");
      runSlashCommand(match.id);
      return;
    }
    setDraft("");
    send(trimmed);
  };

  if (connectionState === "error") {
    return (
      <Screen>
        <Header title="agi chat" subtitle={containerPath} status={<Badge tone="danger">disconnected</Badge>} />
        <Callout title="Connection failed" tone="danger">
          {connectionError ?? "Unknown error"}
        </Callout>
        <StatusBar left={<KeyHint keys="Ctrl+C" label="exit" />} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header
        title="agi chat"
        subtitle={containerPath}
        status={
          connectionState === "connecting"
            ? <Badge tone="warning">connecting…</Badge>
            : <Badge tone="success">connected</Badge>
        }
      />
      {/* fancy-tui's <MessageList> renders <Message> back-to-back with zero
          gap and exposes no spacing prop, so entries run together. Composing
          StaticList + Message directly (both public exports) lets us add a
          blank line between them. Agent replies get a small mushroom Avatar
          alongside — Message itself is sealed (no avatar slot), so it's a
          sibling in the same Row rather than something injected inside it. */}
      <StaticList
        items={messages}
        getKey={(m) => m.id}
        renderItem={(m) => (
          <Box marginBottom={1}>
            {m.role === "agent" ? (
              <Row>
                <Avatar name="Aion" glyph="🍄" />
                <Box flexGrow={1}>
                  <Message message={m} />
                </Box>
              </Row>
            ) : (
              <Message message={m} />
            )}
          </Box>
        )}
      />
      {!quiet && (
        <LiveRegion>
          {thinking && <Spinner label={statusText ?? "Aion is thinking…"} />}
          {liveToolCalls.map((call) => (
            <ToolCall key={call.id} call={call} />
          ))}
        </LiveRegion>
      )}
      {showHelp && (
        <Callout title="Commands" tone="info">
          {SLASH_COMMANDS.map((c) => `${c.label} — ${c.description ?? ""}`).join("\n")}
        </Callout>
      )}
      {isComposingCommand && !thinking && (
        <Command id="slash-commands" query={commandQuery} onQueryChange={() => {}} commands={SLASH_COMMANDS} onSelect={runSlashCommand} />
      )}
      {realtalkMatch !== null && !thinking && (
        <Callout title="0REALTALK" tone={realtalkMatch.kind === "unrecognizedRootTerm" ? "warning" : "info"}>
          {realtalkMatch.summary}
        </Callout>
      )}
      <Composer
        id="prompt"
        value={draft}
        onChange={handleDraftChange}
        onSubmit={handleSubmit}
        placeholder="Message Aion… (/quit to exit, /help for commands)"
      />
      <StatusBar
        left={<KeyHint keys="Ctrl+C" label={thinking ? "cancel" : "exit"} />}
        center={capabilities.shiftEnter ? undefined : <KeyHint keys="Alt+Enter" label="newline" />}
        right={
          <Row>
            {sessionId !== null && <Text tone="muted">sess:{sessionId.slice(0, 8)}</Text>}
            {envelopeRoot !== null && <Badge tone="info">.agi envelope</Badge>}
          </Row>
        }
      />
    </Screen>
  );
}

export function App(props: AppProps): React.JSX.Element {
  return (
    <FancyTuiProvider>
      <ConnectedApp {...props} />
    </FancyTuiProvider>
  );
}
