import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DocWorm, DocWormError } from "../src/client";

type FetchCall = {
  url: string;
  init: RequestInit;
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  const fake = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const resolved: RequestInit = init ?? {};
    calls.push({ url, init: resolved });
    return Promise.resolve(handler(url, resolved));
  };
  vi.stubGlobal("fetch", fake);
  return calls;
}

function requestHeaders(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
}

function makeClient(): DocWorm {
  return new DocWorm({
    apiKey: "test-key",
    baseUrl: "https://api.example.test",
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("client REST requests", () => {
  it("sends Bearer and Accept headers on a GET", async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        fileId: "file-1",
        status: "ready",
        ready: true,
        filename: "report.pdf",
        totalPages: 1,
        processedPages: 1,
        progressPct: 100,
      }),
    );
    const client = makeClient();

    const status = await client.getDocumentStatus("file-1");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://api.example.test/v1/documents/file-1/status",
    );
    expect(calls[0].init.method).toBe("GET");
    const headers = requestHeaders(calls[0].init);
    expect(headers["Authorization"]).toBe("Bearer test-key");
    expect(headers["Accept"]).toBe("application/json");
    expect(status.ready).toBe(true);
  });

  it("sends X-API-KEY and no Authorization for a dw_live_ key", async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        fileId: "file-1",
        status: "ready",
        ready: true,
        filename: "report.pdf",
        totalPages: 1,
        processedPages: 1,
        progressPct: 100,
      }),
    );
    const client = new DocWorm({
      apiKey: "dw_live_test",
      baseUrl: "https://api.example.test",
    });

    await client.getDocumentStatus("file-1");

    expect(calls).toHaveLength(1);
    const headers = requestHeaders(calls[0].init);
    expect(headers["X-API-KEY"]).toBe("dw_live_test");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("sends Bearer and no X-API-KEY for a plain token", async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        fileId: "file-1",
        status: "ready",
        ready: true,
        filename: "report.pdf",
        totalPages: 1,
        processedPages: 1,
        progressPct: 100,
      }),
    );
    const client = makeClient();

    await client.getDocumentStatus("file-1");

    expect(calls).toHaveLength(1);
    const headers = requestHeaders(calls[0].init);
    expect(headers["Authorization"]).toBe("Bearer test-key");
    expect(headers["X-API-KEY"]).toBeUndefined();
  });

  it("posts attachDocuments with a file_ids JSON body", async () => {
    const calls = stubFetch(() =>
      jsonResponse({ chat_id: "chat-1", attachments: [] }),
    );
    const client = makeClient();

    await client.attachDocuments("chat-1", ["file-1", "file-2"]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://api.example.test/v1/chats/chat-1/attach",
    );
    expect(calls[0].init.method).toBe("POST");
    expect(requestHeaders(calls[0].init)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      file_ids: ["file-1", "file-2"],
    });
  });

  it("uploads a multipart FormData body containing the file", async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        status: "uploaded",
        file_id: "file-1",
        filename: "report.pdf",
        gcs_raw_path: "gs://bucket/report.pdf",
      }),
    );
    const client = makeClient();

    const result = await client.upload(Buffer.from("hello"), {
      filename: "report.pdf",
      file_id: "file-1",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.example.test/v1/upload");
    expect(calls[0].init.method).toBe("POST");
    const headers = requestHeaders(calls[0].init);
    expect(headers["Authorization"]).toBe("Bearer test-key");
    // fetch must set the multipart boundary itself.
    expect(headers["Content-Type"]).toBeUndefined();

    const body = calls[0].init.body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get("file_id")).toBe("file-1");
    const file = form.get("file");
    expect(file).toBeInstanceOf(File);
    if (!(file instanceof File)) throw new Error("file entry missing");
    expect(file.name).toBe("report.pdf");
    expect(await file.text()).toBe("hello");

    expect(result.file_id).toBe("file-1");
    expect(result.gcs_raw_path).toBe("gs://bucket/report.pdf");
  });

  it("rejects a 4xx with DocWormError carrying the status", async () => {
    stubFetch(() => new Response("not found", { status: 404 }));
    const client = makeClient();

    await expect(client.getDocumentStatus("missing")).rejects.toBeInstanceOf(
      DocWormError,
    );

    try {
      await client.getDocumentStatus("missing");
    } catch (error) {
      expect(error).toBeInstanceOf(DocWormError);
      const docError = error as DocWormError;
      expect(docError.status).toBe(404);
      expect(docError.body).toBe("not found");
      expect(docError.message).toBe("DocWorm API error 404: not found");
    }
  });
});

describe("waitForIndexing", () => {
  it("polls until the document is ready", async () => {
    let call = 0;
    const calls = stubFetch(() => {
      call += 1;
      if (call === 1) {
        return jsonResponse({
          fileId: "file-1",
          status: "processing",
          ready: false,
          filename: "report.pdf",
          totalPages: 10,
          processedPages: 4,
          progressPct: 40,
        });
      }
      return jsonResponse({
        fileId: "file-1",
        status: "ready",
        ready: true,
        filename: "report.pdf",
        totalPages: 10,
        processedPages: 10,
        progressPct: 100,
      });
    });
    const client = makeClient();

    const status = await client.waitForIndexing("file-1", {
      timeout: 5,
      interval: 0,
    });

    expect(status.ready).toBe(true);
    expect(status.status).toBe("ready");
    expect(calls).toHaveLength(2);
  });

  it("throws DocWormError 422 when indexing failed", async () => {
    stubFetch(() =>
      jsonResponse({
        fileId: "file-1",
        status: "failed",
        ready: false,
        filename: "report.pdf",
        totalPages: 10,
        processedPages: 2,
        progressPct: 20,
        error: "boom",
      }),
    );
    const client = makeClient();

    await expect(
      client.waitForIndexing("file-1", { timeout: 5, interval: 0 }),
    ).rejects.toMatchObject({
      name: "DocWormError",
      status: 422,
      message: "DocWorm API error 422: Indexing failed: boom",
    });
  });

  it("throws DocWormError 408 when the timeout is exhausted", async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        fileId: "file-1",
        status: "processing",
        ready: false,
        filename: "report.pdf",
        totalPages: 10,
        processedPages: 1,
        progressPct: 10,
      }),
    );
    const client = makeClient();

    await expect(
      client.waitForIndexing("file-1", { timeout: 0 }),
    ).rejects.toMatchObject({
      name: "DocWormError",
      status: 408,
      message: "DocWorm API error 408: Indexing timeout after 0s",
    });
    expect(calls).toHaveLength(0);
  });
});
