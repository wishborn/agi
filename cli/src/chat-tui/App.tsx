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
  MessageList,
  LiveRegion,
  Spinner,
  ToolCall,
  Composer,
  StatusBar,
  KeyHint,
  Badge,
  Callout,
  useFancyTui,
} from "@particle-academy/fancy-tui";
import { useChatSession } from "./useChatSession.js";
import type { ChatClientOptions } from "../chat-client.js";

export interface AppProps {
  containerPath: string;
  envelopeRoot: string | null;
  chatClientOptions: ChatClientOptions;
  /** Suppress the live thinking/tool-activity region — just committed messages. */
  quiet?: boolean;
}

function ConnectedApp({ containerPath, envelopeRoot, chatClientOptions, quiet = false }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const { focus } = useFocusManager();
  const { capabilities } = useFancyTui();
  const [draft, setDraft] = useState("");

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
    send,
    cancel,
  } = useChatSession(containerPath, chatClientOptions);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (thinking) {
        cancel();
      } else {
        exit();
      }
    }
  });

  const handleSubmit = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed === "") return;
    if (trimmed === "/quit" || trimmed === "/exit") {
      exit();
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
      <MessageList messages={messages} />
      {!quiet && (
        <LiveRegion>
          {thinking && <Spinner label={statusText ?? "Aion is thinking…"} />}
          {liveToolCalls.map((call) => (
            <ToolCall key={call.id} call={call} />
          ))}
        </LiveRegion>
      )}
      <Composer
        id="prompt"
        value={draft}
        onChange={setDraft}
        onSubmit={handleSubmit}
        placeholder="Message Aion… (/quit to exit)"
      />
      <StatusBar
        left={<KeyHint keys="Ctrl+C" label={thinking ? "cancel" : "exit"} />}
        center={capabilities.shiftEnter ? undefined : <KeyHint keys="Alt+Enter" label="newline" />}
        right={envelopeRoot !== null ? <Badge tone="info">.agi envelope</Badge> : undefined}
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
