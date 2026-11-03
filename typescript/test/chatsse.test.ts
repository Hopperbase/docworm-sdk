import { afterEach, describe, expect, it, vi } from "vitest";

import { DocWorm, DocWormError } from "../src/client";
import type { ChatEvent } from "../src/types";

type FetchCall = { url: string; init: RequestInit };

function sse(event: string, data: unknown, seq = 0): string {
  return `data: ${JSON.stringify({ event, data, seq })}\n\n`;
}

function chunked(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function installFetch(
  chunks: string[],
  options: { status?: number; body?: string } = {},
): FetchCall[] {
  const calls: FetchCall[] = [];
  const status = options.status ?? 200;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init: init ?? {} });
      if (status >= 400) {
        return new Response(options.body ?? "", { status });
      }
      return new Response(streamFromChunks(chunks), { status });
    },
  );
  return calls;
}

function headersOf(call: FetchCall): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

function bodyOf(call: FetchCall): unknown {
  return JSON.parse(call.init.body as string);
}

function makeClient(apiKey: string): DocWorm {
  return new DocWorm({ apiKey, baseUrl: "https://api.example.test" });
}

async function collect(stream: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chatStreamSse request", () => {
  it("posts to the stream endpoint with SSE headers and bearer auth", async () => {
    const calls = installFetch([sse("done", { msg_id: "msg-1" })]);
    const client = makeClient("firebase-token");

    await collect(client.chatStreamSse("chat-1", "hello"));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://api.example.test/v1/chats/chat-1/stream",
    );
    expect(calls[0].init.method).toBe("POST");
    const headers = headersOf(calls[0]);
    expect(headers.Authorization).toBe("Bearer firebase-token");
    expect(headers.Accept).toBe("text/event-stream");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-API-KEY"]).toBeUndefined();
  });

  it("uses X-API-KEY and omits Authorization for a dw_live_ key", async () => {
    const calls = installFetch([sse("done", { msg_id: "msg-1" })]);
    const client = makeClient("dw_live_abc123");

    await collect(client.chatStreamSse("chat-1", "hello"));

    const headers = headersOf(calls[0]);
    expect(headers["X-API-KEY"]).toBe("dw_live_abc123");
    expect(headers.Authorization).toBeUndefined();
  });

  it("omits unset optional chat fields", async () => {
    const calls = installFetch([sse("done", { msg_id: "msg-1" })]);
    const client = makeClient("test-key");

    await collect(client.chatStreamSse("chat-1", "hello"));

    expect(bodyOf(calls[0])).toEqual({ type: "chat", message: "hello" });
  });

  it("includes provided optional chat fields", async () => {
    const calls = installFetch([sse("done", { msg_id: "msg-1" })]);
    const client = makeClient("test-key");

    await collect(
      client.chatStreamSse("chat-1", "", {
        model: "gpt-test",
        orchestration: "direct",
        parentMsgId: "parent-1",
        retryMsgId: "retry-1",
        baseMsgId: "base-1",
      }),
    );

    expect(bodyOf(calls[0])).toEqual({
      type: "chat",
      message: "",
      model: "gpt-test",
      orchestration: "direct",
      parent_msg_id: "parent-1",
      retry_msg_id: "retry-1",
      base_msg_id: "base-1",
    });
  });

  it("passes the abort signal through to fetch", async () => {
    const calls = installFetch([sse("done", { msg_id: "msg-1" })]);
    const client = makeClient("test-key");
    const controller = new AbortController();

    await collect(
      client.chatStreamSse("chat-1", "hello", { signal: controller.signal }),
    );

    expect(calls[0].init.signal).toBe(controller.signal);
  });
});

describe("chatReconnectSse request", () => {
  it("sends a reconnect body defaulting to last_seq -1", async () => {
    const calls = installFetch([sse("done", { msg_id: "msg-1" })]);
    const client = makeClient("test-key");

    await collect(client.chatReconnectSse("chat-1", "msg-1"));

    expect(bodyOf(calls[0])).toEqual({
      type: "reconnect",
      msg_id: "msg-1",
      last_seq: -1,
    });
  });

  it("sends an explicit last_seq", async () => {
    const calls = installFetch([sse("done", { msg_id: "msg-1" })]);
    const client = makeClient("test-key");

    await collect(client.chatReconnectSse("chat-1", "msg-1", 42));

    expect(bodyOf(calls[0])).toEqual({
      type: "reconnect",
      msg_id: "msg-1",
      last_seq: 42,
    });
  });
});

describe("chatStreamSse events", () => {
  it("maps answer_chunk to a ChatEvent", async () => {
    installFetch([
      sse("answer_chunk", { text: "the answer" }),
      sse("done", { msg_id: "msg-1" }),
    ]);
    const client = makeClient("test-key");

    const events = await collect(client.chatStreamSse("chat-1", "hello"));

    expect(events.map((event) => event.type)).toEqual(["answer", "done"]);
    expect(events[0].text).toBe("the answer");
    expect(events[0].data).toEqual({ text: "the answer" });
    expect(events[1].msg_id).toBe("msg-1");
  });

  it("stops after done", async () => {
    installFetch([
      sse("thinking_chunk", { text: "thinking" }),
      sse("done", { msg_id: "msg-1" }),
      sse("answer_chunk", { text: "too late" }),
    ]);
    const client = makeClient("test-key");

    const events = await collect(client.chatStreamSse("chat-1", "hello"));

    expect(events.map((event) => event.type)).toEqual(["thinking", "done"]);
    expect(events[0].text).toBe("thinking");
  });

  it("stops after an error event", async () => {
    installFetch([
      sse("error", { error: { code: "quota", detail: "x" } }),
      sse("answer_chunk", { text: "unreachable" }),
    ]);
    const client = makeClient("test-key");

    const events = await collect(client.chatStreamSse("chat-1", "hello"));

    expect(events.map((event) => event.type)).toEqual(["error"]);
    expect(events[0].error).toBe('{"code":"quota","detail":"x"}');
  });

  it("skips unmapped events without ending iteration", async () => {
    installFetch([
      sse("ping", {}),
      sse("answer_chunk", { text: "still streaming" }),
      sse("status_heartbeat", {}),
      sse("done", { msg_id: "msg-1" }),
    ]);
    const client = makeClient("test-key");

    const events = await collect(client.chatStreamSse("chat-1", "hello"));

    expect(events.map((event) => event.type)).toEqual(["answer", "done"]);
    expect(events[0].text).toBe("still streaming");
  });

  it("ignores comments and non-data lines", async () => {
    installFetch([
      ": keep-alive comment\n",
      "event: message\n",
      "id: 7\n",
      sse("answer_chunk", { text: "after noise" }),
      sse("done", { msg_id: "msg-1" }),
    ]);
    const client = makeClient("test-key");

    const events = await collect(client.chatStreamSse("chat-1", "hello"));

    expect(events.map((event) => event.type)).toEqual(["answer", "done"]);
    expect(events[0].text).toBe("after noise");
  });

  it("dispatches on a blank line and flushes a final event without one", async () => {
    installFetch([
      sse("answer_chunk", { text: "first" }),
      `data: ${JSON.stringify({ event: "done", data: { msg_id: "msg-1" } })}`,
    ]);
    const client = makeClient("test-key");

    const events = await collect(client.chatStreamSse("chat-1", "hello"));

    expect(events.map((event) => event.type)).toEqual(["answer", "done"]);
    expect(events[0].text).toBe("first");
  });

  it("joins multi-line data payloads with a newline", async () => {
    const frame = JSON.stringify(
      { event: "answer_chunk", data: { text: "joined" }, seq: 3 },
      null,
      0,
    );
    const lines = frame.split("\n").map((line) => `data: ${line}\n`);
    installFetch([
      ...lines,
      "\n",
      sse("done", { msg_id: "msg-1" }),
    ]);
    const client = makeClient("test-key");

    const events = await collect(client.chatStreamSse("chat-1", "hello"));

    expect(events.map((event) => event.type)).toEqual(["answer", "done"]);
    expect(events[0].text).toBe("joined");
  });

  it("reassembles lines split across stream chunks", async () => {
    const text =
      sse("answer_chunk", { text: "split across chunks" }) +
      sse("done", { msg_id: "msg-1" });
    installFetch(chunked(text, 7));
    const client = makeClient("test-key");

    const events = await collect(client.chatStreamSse("chat-1", "hello"));

    expect(events.map((event) => event.type)).toEqual(["answer", "done"]);
    expect(events[0].text).toBe("split across chunks");
  });

  it("keeps JSON-string data as an empty object", async () => {
    installFetch([
      `data: ${JSON.stringify({
        event: "answer_chunk",
        data: JSON.stringify({ text: "string data" }),
      })}\n\n`,
      sse("done", { msg_id: "msg-1" }),
    ]);
    const client = makeClient("test-key");

    const events = await collect(client.chatStreamSse("chat-1", "hello"));

    expect(events.map((event) => event.type)).toEqual(["answer", "done"]);
    expect(events[0].text).toBe("");
    expect(events[0].data).toEqual({});
  });
});

describe("chatStreamSse errors", () => {
  it("throws DocWormError on a non-2xx response", async () => {
    installFetch([], { status: 404, body: "chat not found" });
    const client = makeClient("test-key");

    const error: unknown = await collect(
      client.chatStreamSse("chat-1", "hello"),
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(DocWormError);
    expect(error).toMatchObject({ status: 404, body: "chat not found" });
  });
});
