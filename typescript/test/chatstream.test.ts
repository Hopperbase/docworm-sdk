import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DocWorm } from "../src/client";
import type { ChatEvent } from "../src/types";

type WsScript = {
  auth: string;
  events: string[];
};

/**
 * Minimal WebSocket stand-in. It records every frame the SDK sends and, after
 * the auth frame, replays the scripted auth response; after the request frame
 * it replays the scripted event frames and then a close event.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static script: WsScript = { auth: '{"type":"auth_ok"}', events: [] };

  readonly url: string;
  sent: string[] = [];
  closed = false;

  private readonly listeners = new Map<string, Array<(event: Event) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("open", new Event("open")));
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      existing.filter((candidate) => candidate !== listener),
    );
  }

  send(data: string): void {
    this.sent.push(data);
    if (this.sent.length === 1) {
      queueMicrotask(() => {
        this.emit("message", this.messageEvent(FakeWebSocket.script.auth));
      });
      return;
    }
    if (this.sent.length === 2) {
      queueMicrotask(() => {
        for (const frame of FakeWebSocket.script.events) {
          this.emit("message", this.messageEvent(frame));
        }
        this.emit("close", new Event("close"));
      });
    }
  }

  close(): void {
    this.closed = true;
  }

  private messageEvent(data: string): Event {
    return { data } as unknown as MessageEvent;
  }

  private emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function jsonFrame(event: string, data: unknown): string {
  return JSON.stringify({ event, data });
}

function install(script: Partial<WsScript>): void {
  FakeWebSocket.instances = [];
  FakeWebSocket.script = {
    auth: script.auth ?? '{"type":"auth_ok"}',
    events: script.events ?? [],
  };
  vi.stubGlobal("WebSocket", FakeWebSocket);
}

function makeClient(apiKey: string): DocWorm {
  return new DocWorm({ apiKey, baseUrl: "https://api.example.test" });
}

function onlySocket(): FakeWebSocket {
  expect(FakeWebSocket.instances).toHaveLength(1);
  return FakeWebSocket.instances[0];
}

async function collect(stream: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeWebSocket.script = { auth: '{"type":"auth_ok"}', events: [] };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chatStream auth handshake", () => {
  it("sends a token auth frame for a plain key", async () => {
    install({ events: [jsonFrame("done", { msg_id: "msg-1" })] });
    const client = makeClient("firebase-token");

    await collect(client.chatStream("chat-1", "hello"));

    const ws = onlySocket();
    expect(ws.url).toBe(
      "wss://api.example.test/v1/chats/chat-1/chat",
    );
    expect(ws.sent[0]).toBe(
      JSON.stringify({ type: "auth", token: "firebase-token" }),
    );
    expect(ws.sent[1]).toBe(
      JSON.stringify({
        type: "chat",
        message: "hello",
        orchestration: "auto",
      }),
    );
  });

  it("sends an api_key auth frame for a dw_live_ key", async () => {
    install({ events: [jsonFrame("done", { msg_id: "msg-1" })] });
    const client = makeClient("dw_live_abc123");

    await collect(client.chatStream("chat-1", "hello"));

    const ws = onlySocket();
    expect(ws.sent[0]).toBe(
      JSON.stringify({ type: "auth", api_key: "dw_live_abc123" }),
    );
    expect(JSON.parse(ws.sent[0])).not.toHaveProperty("token");
  });

  it("surfaces an auth error and never sends the chat frame", async () => {
    install({
      auth: JSON.stringify({ type: "error", error: "bad key" }),
      events: [],
    });
    const client = makeClient("test-key");

    const events = await collect(client.chatStream("chat-1", "hello"));

    expect(events.map((event) => event.type)).toEqual(["error"]);
    expect(events[0].error).toBe("bad key");
    expect(onlySocket().sent).toHaveLength(1);
  });

  it("surfaces an invalid auth response", async () => {
    install({ auth: "not json", events: [] });
    const client = makeClient("test-key");

    const events = await collect(client.chatStream("chat-1", "hello"));

    expect(events.map((event) => event.type)).toEqual(["error"]);
    expect(events[0].error).toBe("WebSocket auth: invalid response");
  });
});

describe("chatStream events", () => {
  it("maps answer_chunk and stops at done", async () => {
    install({
      events: [
        jsonFrame("answer_chunk", { text: "hello" }),
        jsonFrame("done", { msg_id: "msg-1" }),
        // Never delivered because the generator returns on done.
        jsonFrame("answer_chunk", { text: "too late" }),
      ],
    });
    const client = makeClient("test-key");

    const events = await collect(client.chatStream("chat-1", "hi"));

    expect(events.map((event) => event.type)).toEqual(["answer", "done"]);
    expect(events[0].text).toBe("hello");
    expect(events[0].data).toEqual({ text: "hello" });
    expect(events[1].msg_id).toBe("msg-1");
    expect(onlySocket().closed).toBe(true);
  });

  it("maps thinking_chunk, thought, status_chunk, trace, plan and todo", async () => {
    install({
      events: [
        jsonFrame("thinking_chunk", { text: "chunk" }),
        jsonFrame("thought", { text: "thought" }),
        jsonFrame("status_chunk", { text: "working" }),
        jsonFrame("trace_item", { text: "trace" }),
        jsonFrame("plan_update", { steps: ["a"] }),
        jsonFrame("todo_updated", { items: ["x"] }),
        jsonFrame("done", { msg_id: "msg-1" }),
      ],
    });
    const client = makeClient("test-key");

    const events = await collect(client.chatStream("chat-1", "hi"));

    expect(events.map((event) => event.type)).toEqual([
      "thinking",
      "thinking",
      "status",
      "trace",
      "plan",
      "todo",
      "done",
    ]);
    expect(events[0].text).toBe("chunk");
    expect(events[1].text).toBe("thought");
    expect(events[2].text).toBe("working");
    expect(events[3].text).toBe("trace");
    expect(events[4].data).toEqual({ steps: ["a"] });
    expect(events[5].data).toEqual({ items: ["x"] });
  });

  it("keeps string data as an empty object (no normalization)", async () => {
    // Divergence from the Python SDK: client.ts:528-531 only accepts object
    // data, so a JSON-string data payload yields an empty event.
    install({
      events: [
        JSON.stringify({
          event: "answer_chunk",
          data: JSON.stringify({ text: "string data" }),
        }),
        jsonFrame("done", { msg_id: "msg-1" }),
      ],
    });
    const client = makeClient("test-key");

    const events = await collect(client.chatStream("chat-1", "hi"));

    expect(events.map((event) => event.type)).toEqual(["answer", "done"]);
    expect(events[0].text).toBe("");
    expect(events[0].data).toEqual({});
  });

  it("surfaces an error event then terminates", async () => {
    install({
      events: [
        jsonFrame("error", { error: { code: "quota", detail: "x" } }),
        jsonFrame("answer_chunk", { text: "unreachable" }),
      ],
    });
    const client = makeClient("test-key");

    const events = await collect(client.chatStream("chat-1", "hi"));

    expect(events.map((event) => event.type)).toEqual(["error"]);
    expect(events[0].error).toBe('{"code":"quota","detail":"x"}');
  });

  it("skips unmapped events without ending iteration", async () => {
    install({
      events: [
        jsonFrame("plan_declared", { plan: ["a"] }),
        jsonFrame("answer_chunk", { text: "still streaming" }),
        jsonFrame("ping", {}),
        jsonFrame("done", { msg_id: "msg-1" }),
      ],
    });
    const client = makeClient("test-key");

    const events = await collect(client.chatStream("chat-1", "hi"));

    expect(events.map((event) => event.type)).toEqual(["answer", "done"]);
    expect(events[0].text).toBe("still streaming");
  });
});

describe("chatStream frames", () => {
  it("adds retry context and attached docs when supplied", async () => {
    install({ events: [jsonFrame("done", { msg_id: "msg-1" })] });
    const client = makeClient("test-key");

    await collect(
      client.chatStream("chat-1", "", {
        attached_docs: [{ id: "file-1", name: "report.pdf" }],
        orchestration: "direct",
        parent_msg_id: "parent-1",
        retry_msg_id: "retry-1",
        base_msg_id: "base-1",
      }),
    );

    expect(JSON.parse(onlySocket().sent[1])).toEqual({
      type: "chat",
      message: "",
      orchestration: "direct",
      attached_docs: [{ id: "file-1", name: "report.pdf" }],
      parent_msg_id: "parent-1",
      retry_msg_id: "retry-1",
      base_msg_id: "base-1",
    });
  });

  it("sends a reconnect frame defaulting to last_seq -1", async () => {
    install({ events: [jsonFrame("done", { msg_id: "msg-1" })] });
    const client = makeClient("test-key");

    await collect(client.chatReconnect("chat-1", "msg-1"));

    expect(JSON.parse(onlySocket().sent[1])).toEqual({
      type: "reconnect",
      msg_id: "msg-1",
      last_seq: -1,
    });
  });

  it("sends a chat_interrupt frame", async () => {
    install({ events: [jsonFrame("done", { msg_id: "msg-1" })] });
    const client = makeClient("test-key");

    await collect(client.chatInterrupt("chat-1", "stop"));

    expect(JSON.parse(onlySocket().sent[1])).toEqual({
      type: "chat_interrupt",
      message: "stop",
      orchestration: "auto",
    });
  });
});
