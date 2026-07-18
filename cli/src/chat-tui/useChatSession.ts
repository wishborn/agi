/**
 * Bridges `ChatClient` (the WS protocol client — connect/open/send/cancel,
 * unchanged from `agi chat`'s original readline-REPL ship) into React state
 * shaped for `@particle-academy/fancy-tui`'s components. This is the only
 * file that touches `ChatClient` directly.
 *
 * The event → state mapping itself lives in the pure `chatSessionReducer`
 * below (unit-tested in `chat-session-reducer.test.ts` without any React
 * rendering) — `useChatSession` is a thin `useReducer` binding layer over
 * it plus the `ChatClient` wiring, matching this codebase's convention of
 * testing pure logic directly and manually smoke-testing framework glue.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { MessageData, MessageRole, ToolCallData } from "@particle-academy/fancy-tui";
import {
  ChatClient,
  ChatTimeoutError,
  ChatTurnError,
  type ChatClientOptions,
  type ChatToolStartEvent,
  type ChatToolResultEvent,
} from "../chat-client.js";

export type ConnectionState = "connecting" | "open" | "closed" | "error";

export interface ChatSessionState {
  messages: MessageData[];
  /** True while a turn is in flight (from send() until its terminal event). */
  thinking: boolean;
  /** Latest thinking/progress/thought text, if any — used as the live spinner's label. */
  statusText: string | null;
  /** Tool calls still in flight for the current turn — folded into `messages` once each resolves. */
  liveToolCalls: ToolCallData[];
  nextMessageSeq: number;
}

export const initialChatSessionState: ChatSessionState = {
  messages: [],
  thinking: false,
  statusText: null,
  liveToolCalls: [],
  nextMessageSeq: 1,
};

export type ChatSessionEvent =
  | { type: "userSent"; text: string; timestamp: string }
  | { type: "thinking" }
  | { type: "toolStart"; event: ChatToolStartEvent }
  | { type: "toolResult"; event: ChatToolResultEvent; timestamp: string }
  | { type: "progress"; text: string }
  | { type: "thought"; content: string }
  | { type: "agentResponded"; text: string; timestamp: string }
  | { type: "turnFailed"; message: string; timestamp: string };

/** Correlates a tool's `chat:tool_start` with its later `chat:tool_result` — same convention `server.ts` itself uses for tool-card ids. */
export function toolCallId(event: ChatToolStartEvent | ChatToolResultEvent): string {
  return `${String(event.loopIteration)}-${String(event.toolIndex)}`;
}

function appendMessage(
  state: ChatSessionState,
  role: MessageRole,
  content: string,
  timestamp: string,
  name?: string,
): ChatSessionState {
  return {
    ...state,
    nextMessageSeq: state.nextMessageSeq + 1,
    messages: [...state.messages, { id: `m${String(state.nextMessageSeq)}`, role, content, name, timestamp }],
  };
}

export function chatSessionReducer(state: ChatSessionState, event: ChatSessionEvent): ChatSessionState {
  switch (event.type) {
    case "userSent":
      return appendMessage(state, "user", event.text, event.timestamp);
    case "thinking":
      return { ...state, thinking: true, statusText: "Aion is thinking…" };
    case "toolStart": {
      const id = toolCallId(event.event);
      return {
        ...state,
        liveToolCalls: [
          ...state.liveToolCalls.filter((c) => c.id !== id),
          { id, name: event.event.toolName, status: "pending" },
        ],
      };
    }
    case "toolResult": {
      const id = toolCallId(event.event);
      const withoutLive = { ...state, liveToolCalls: state.liveToolCalls.filter((c) => c.id !== id) };
      return appendMessage(
        withoutLive,
        "tool",
        `${event.event.toolName}: ${event.event.summary}`,
        event.timestamp,
        event.event.toolName,
      );
    }
    case "progress":
      return { ...state, statusText: event.text };
    case "thought":
      return { ...state, statusText: event.content };
    case "agentResponded":
      return appendMessage({ ...state, thinking: false, statusText: null }, "agent", event.text, event.timestamp);
    case "turnFailed":
      return appendMessage(
        { ...state, thinking: false, statusText: null, liveToolCalls: [] },
        "error",
        event.message,
        event.timestamp,
      );
    default:
      return state;
  }
}

export interface UseChatSessionResult extends ChatSessionState {
  connectionState: ConnectionState;
  connectionError: string | null;
  send: (text: string) => void;
  cancel: () => void;
}

export function useChatSession(context: string, opts: ChatClientOptions = {}): UseChatSessionResult {
  const { host, port, sendTimeoutMs, webSocketImpl } = opts;
  const clientRef = useRef<ChatClient | null>(null);
  const [state, dispatch] = useReducer(chatSessionReducer, initialChatSessionState);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [connectionError, setConnectionError] = useState<string | null>(null);

  useEffect(() => {
    const client = new ChatClient({ host, port, sendTimeoutMs, webSocketImpl });
    clientRef.current = client;
    let cancelled = false;

    client.on({
      onThinking: () => dispatch({ type: "thinking" }),
      onToolStart: (event) => dispatch({ type: "toolStart", event }),
      onToolResult: (event) => dispatch({ type: "toolResult", event, timestamp: new Date().toISOString() }),
      onProgress: (event) => dispatch({ type: "progress", text: event.text }),
      onThought: (content) => dispatch({ type: "thought", content }),
      onUnsolicitedResponse: (text) => dispatch({ type: "agentResponded", text, timestamp: new Date().toISOString() }),
      onClosed: () => { if (!cancelled) setConnectionState("closed"); },
    });

    client.open(context)
      .then(() => { if (!cancelled) setConnectionState("open"); })
      .catch((err: unknown) => {
        if (cancelled) return;
        setConnectionState("error");
        setConnectionError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      client.close();
    };
  }, [context, host, port, sendTimeoutMs, webSocketImpl]);

  const send = useCallback((text: string) => {
    const client = clientRef.current;
    if (!client) return;
    dispatch({ type: "userSent", text, timestamp: new Date().toISOString() });
    dispatch({ type: "thinking" });
    client.send(text)
      .then((responseText) => {
        dispatch({ type: "agentResponded", text: responseText, timestamp: new Date().toISOString() });
      })
      .catch((err: unknown) => {
        const timestamp = new Date().toISOString();
        if (err instanceof ChatTimeoutError) {
          dispatch({ type: "turnFailed", message: `Timed out: ${err.message}`, timestamp });
        } else if (err instanceof ChatTurnError) {
          dispatch({ type: "turnFailed", message: `Error: ${err.message}`, timestamp });
        } else {
          dispatch({ type: "turnFailed", message: err instanceof Error ? err.message : String(err), timestamp });
        }
      });
  }, []);

  const cancel = useCallback(() => {
    clientRef.current?.cancel();
  }, []);

  return { ...state, connectionState, connectionError, send, cancel };
}
