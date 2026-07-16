/**
 * ChatClient — message framing/parsing unit tests against a mock
 * WebSocket (no real network, no real gateway). Verifies the client-side
 * half of the protocol documented in `@agi/gateway-core`'s
 * chat-ws-types.ts: open()/send() resolve on the right server events,
 * progress handlers fire without resolving the in-flight turn, and
 * connection failures surface as a clear error.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatClient, ChatWsUnreachableError, ChatTurnError } from "./chat-client.js";

type Listener = (event: { data?: string }) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  sent: string[] = [];
  private listeners: Record<string, Listener[]> = {};

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: Listener): void {
    (this.listeners[type] ??= []).push(cb);
  }

  removeEventListener(type: string, cb: Listener): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== cb);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit("close", {});
  }

  emit(type: string, event: { data?: string } = {}): void {
    // Copy before iterating — a callback (e.g. a `{once:true}` handler) may
    // call removeEventListener, which would otherwise mutate this array
    // mid-iteration.
    const callbacks = (this.listeners[type] ?? []).slice();
    for (const cb of callbacks) cb(event);
  }

  simulateOpen(): void {
    this.emit("open");
  }

  simulateServerMessage(payload: unknown): void {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  lastSentPayload(): { type: string; payload?: Record<string, unknown> } {
    return JSON.parse(this.sent.at(-1)!) as { type: string; payload?: Record<string, unknown> };
  }
}

beforeEach(() => {
  MockWebSocket.instances = [];
});

/**
 * Let pending microtasks run. Needed between `ws.simulateOpen()` (which
 * resolves `connect()`'s promise) and simulating the server's next reply —
 * `ChatClient.open()`'s continuation (which sets `pendingOpen` and sends
 * `chat:open`) resumes on a microtask, not synchronously. Real network
 * round-trip time always dwarfs this in production; it only matters for a
 * synchronous mock like this one.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function openedClient(context = "/some/project"): Promise<{ client: ChatClient; ws: MockWebSocket }> {
  const client = new ChatClient({ host: "127.0.0.1", port: 3100, webSocketImpl: MockWebSocket });
  const openPromise = client.open(context);
  const ws = MockWebSocket.instances[0]!;
  ws.simulateOpen();
  await flushMicrotasks();
  ws.simulateServerMessage({ type: "chat:opened", payload: { sessionId: "sess-1", context, messages: [] } });
  await openPromise;
  return { client, ws };
}

describe("ChatClient — connect + open", () => {
  it("connects to ws://<host>:<port>/ws", async () => {
    const { ws } = await openedClient();
    expect(ws.url).toBe("ws://127.0.0.1:3100/ws");
  });

  it("sends chat:open with the given context and resolves with the session on chat:opened", async () => {
    const { ws } = await openedClient("/home/user/proj");
    const sent = ws.lastSentPayload();
    expect(sent.type).toBe("chat:open");
    expect(sent.payload?.context).toBe("/home/user/proj");
  });

  it("rejects open() with ChatWsUnreachableError when the socket errors before opening", async () => {
    const client = new ChatClient({ webSocketImpl: MockWebSocket });
    const openPromise = client.open("/some/project");
    const ws = MockWebSocket.instances[0]!;
    ws.emit("error");
    await expect(openPromise).rejects.toThrow(ChatWsUnreachableError);
  });

  it("rejects open() with ChatTurnError when the gateway sends chat:error instead of chat:opened", async () => {
    const client = new ChatClient({ webSocketImpl: MockWebSocket });
    const openPromise = client.open("/some/project");
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();
    await flushMicrotasks();
    ws.simulateServerMessage({ type: "chat:error", payload: { error: "Owner not configured" } });
    await expect(openPromise).rejects.toThrow(ChatTurnError);
  });
});

describe("ChatClient — send()", () => {
  it("resends the session's context on every send (not just open)", async () => {
    const { client, ws } = await openedClient("/home/user/proj");
    const sendPromise = client.send("hello");
    const sent = ws.lastSentPayload();
    expect(sent.type).toBe("chat:send");
    expect(sent.payload?.sessionId).toBe("sess-1");
    expect(sent.payload?.context).toBe("/home/user/proj");
    ws.simulateServerMessage({ type: "chat:response", payload: { sessionId: "sess-1", text: "hi there", timestamp: "t" } });
    await expect(sendPromise).resolves.toBe("hi there");
  });

  it("rejects the turn on chat:error", async () => {
    const { client, ws } = await openedClient();
    const sendPromise = client.send("hello");
    ws.simulateServerMessage({ type: "chat:error", payload: { sessionId: "sess-1", error: "boom" } });
    await expect(sendPromise).rejects.toThrow(ChatTurnError);
  });

  it("rejects the turn on chat:cancelled", async () => {
    const { client, ws } = await openedClient();
    const sendPromise = client.send("hello");
    ws.simulateServerMessage({ type: "chat:cancelled", payload: { sessionId: "sess-1", timestamp: "t" } });
    await expect(sendPromise).rejects.toThrow(/cancelled/i);
  });

  it("fires progress handlers during a turn without resolving it", async () => {
    const { client, ws } = await openedClient();
    const onToolStart = vi.fn();
    const onToolResult = vi.fn();
    const onThought = vi.fn();
    const onProgress = vi.fn();
    client.on({ onToolStart, onToolResult, onThought, onProgress });

    const sendPromise = client.send("do a thing");
    ws.simulateServerMessage({ type: "chat:tool_start", payload: { sessionId: "sess-1", runId: "r1", toolName: "grep_search", toolIndex: 0, loopIteration: 0, timestamp: "t" } });
    ws.simulateServerMessage({ type: "chat:tool_result", payload: { sessionId: "sess-1", runId: "r1", toolName: "grep_search", toolIndex: 0, loopIteration: 0, success: true, summary: "found 3", timestamp: "t" } });
    ws.simulateServerMessage({ type: "chat:thought", payload: { sessionId: "sess-1", runId: "r1", content: "thinking...", timestamp: "t" } });
    ws.simulateServerMessage({ type: "chat:progress", payload: { sessionId: "sess-1", text: "working", phase: "tool_loop", timestamp: "t" } });

    expect(onToolStart).toHaveBeenCalledWith(expect.objectContaining({ toolName: "grep_search" }));
    expect(onToolResult).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(onThought).toHaveBeenCalledWith("thinking...");
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: "tool_loop" }));

    ws.simulateServerMessage({ type: "chat:response", payload: { sessionId: "sess-1", text: "done", timestamp: "t" } });
    await expect(sendPromise).resolves.toBe("done");
  });

  it("routes a chat:response with no in-flight turn to onUnsolicitedResponse instead of throwing", async () => {
    const { client, ws } = await openedClient();
    const onUnsolicitedResponse = vi.fn();
    client.on({ onUnsolicitedResponse });

    // No send() is in flight — this frame arrives on its own (e.g. an
    // injected follow-up after a handoff resolves).
    ws.simulateServerMessage({ type: "chat:response", payload: { sessionId: "sess-1", text: "async follow-up", timestamp: "t" } });

    expect(onUnsolicitedResponse).toHaveBeenCalledWith("async follow-up");
  });
});

describe("ChatClient — close()", () => {
  it("sends chat:close then closes the socket", async () => {
    const { client, ws } = await openedClient();
    client.close();
    const sent = ws.lastSentPayload();
    expect(sent.type).toBe("chat:close");
    expect(sent.payload?.sessionId).toBe("sess-1");
  });
});
