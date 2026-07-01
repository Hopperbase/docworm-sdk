import type {
  ChatEvent,
  ChatInfo,
  ChatStreamOptions,
  CodegenResponse,
  DocumentStatus,
  ExcelPreview,
  IndexBatchResponse,
  IndexResponse,
  MessageList,
  OriginalFile,
  PageContent,
  PageImage,
  PageInfo,
  QueryOptions,
  QueryResponse,
  RetryFailedResponse,
  Skill,
  TreeNode,
  UploadResponse,
} from "./types.js";
import { resolveConfig, DocWormConfig } from "./config.js";

export type { DocWormConfig } from "./config.js";

export class DocWormError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string) {
    super(`DocWorm API error ${status}: ${body}`);
    this.name = "DocWormError";
    this.status = status;
    this.body = body;
  }
}

const SUCCESS_STATUSES = new Set(["ready", "completed", "indexed"]);
const FAILED_STATUSES = new Set(["error", "failed", "cancelled"]);

export class DocWorm {
  private baseUrl: string;
  private apiKey: string;

  constructor(config: DocWormConfig = {}) {
    const cfg = resolveConfig(config);
    this.baseUrl = cfg.base_url.replace(/\/$/, "");
    this.apiKey = cfg.api_key;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  private qs(params?: Record<string, string | number | boolean>): string {
    if (!params) return "";
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      clean[k] = String(v);
    }
    const s = new URLSearchParams(clean).toString();
    return s ? `?${s}` : "";
  }

  private async requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        ...this.headers(),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new DocWormError(res.status, text);
    }
    if (res.status === 204) return {} as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Public low-level HTTP escape hatch for endpoints the SDK doesn't wrap. */
  async rawRequest<T = Record<string, unknown>>(
    method: string,
    path: string,
    options?: { params?: Record<string, string | number | boolean>; json?: unknown; timeout?: number },
  ): Promise<T> {
    const ctrl = new AbortController();
    const timer = options?.timeout
      ? setTimeout(() => ctrl.abort(), options.timeout * 1000)
      : undefined;
    try {
      return await this.requestJson<T>(
        method,
        `${path}${this.qs(options?.params)}`,
        options?.json,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private wsUrl(path: string): string {
    return `${this.baseUrl.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://")}${path}`;
  }

  private wsAuthFrame(): Record<string, string> {
    if (this.apiKey.startsWith("dw_live_")) return { type: "auth", api_key: this.apiKey };
    return { type: "auth", token: this.apiKey };
  }

  private async toBlob(file: File | Buffer | string): Promise<{ blob: Blob; filename: string }> {
    if (typeof file === "string") {
      const { readFile } = await import("fs/promises");
      const { basename } = await import("path");
      return { blob: new Blob([await readFile(file)]), filename: basename(file) };
    }
    if (typeof Buffer !== "undefined" && file instanceof Buffer) {
      return { blob: new Blob([new Uint8Array(file)]), filename: "document.pdf" };
    }
    const f = file as File;
    return { blob: f, filename: f.name || "document.pdf" };
  }

  // ── Documents ──────────────────────────────────────────────

  async upload(
    file: File | Buffer | string,
    options?: { filename?: string; file_id?: string; project_id?: string; chat_id?: string; folder_id?: string },
  ): Promise<UploadResponse> {
    const form = new FormData();
    const { blob, filename: detected } = await this.toBlob(file);
    const filename = options?.filename || detected;

    form.append("file", blob, filename);
    if (options?.file_id) form.append("file_id", options.file_id);
    if (options?.project_id) form.append("project_id", options.project_id);
    if (options?.chat_id) form.append("chat_id", options.chat_id);
    if (options?.folder_id) form.append("folder_id", options.folder_id);

    const res = await fetch(`${this.baseUrl}/v1/upload`, {
      method: "POST",
      headers: this.headers(),
      body: form,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new DocWormError(res.status, text);
    }
    return res.json() as Promise<UploadResponse>;
  }

  async index(
    file_id: string,
    options?: { project_id?: string; chat_id?: string; folder_id?: string; file?: File | Buffer | string; filename?: string },
  ): Promise<IndexResponse> {
    if (!options?.file) {
      const form = new FormData();
      form.append("file_id", file_id);
      if (options?.project_id) form.append("project_id", options.project_id);
      if (options?.chat_id) form.append("chat_id", options.chat_id);
      if (options?.folder_id) form.append("folder_id", options.folder_id);
      const res = await fetch(`${this.baseUrl}/v1/index`, {
        method: "POST",
        headers: this.headers(),
        body: form,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new DocWormError(res.status, text);
      }
      return res.json() as Promise<IndexResponse>;
    }
    // One-step upload + index.
    const form = new FormData();
    form.append("file_id", file_id);
    const { blob, filename: detected } = await this.toBlob(options.file);
    form.append("file", blob, options.filename || detected);
    const res = await fetch(`${this.baseUrl}/v1/index`, {
      method: "POST",
      headers: this.headers(),
      body: form,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new DocWormError(res.status, text);
    }
    return res.json() as Promise<IndexResponse>;
  }

  async uploadAndIndex(
    file: File | Buffer | string,
    options?: { filename?: string; file_id?: string; project_id?: string; chat_id?: string; folder_id?: string },
  ): Promise<IndexResponse> {
    const upload = await this.upload(file, options);
    return this.index(upload.file_id, {
      project_id: options?.project_id,
      chat_id: options?.chat_id,
      folder_id: options?.folder_id,
    });
  }

  async indexJson(file_id: string, tree: Record<string, unknown>[], filename = "document.json"): Promise<IndexResponse> {
    return this.requestJson("POST", "/v1/index-json", { file_id, filename, tree });
  }

  async indexBatch(file_ids: string[]): Promise<IndexBatchResponse> {
    return this.requestJson("POST", "/v1/index/batch", { file_ids });
  }

  async retryFailedPages(file_id: string): Promise<RetryFailedResponse> {
    return this.requestJson("POST", `/v1/index/retry-failed${this.qs({ file_id })}`);
  }

  async cancelIndexing(file_ids: string[]): Promise<{ cancelled: number }> {
    return this.requestJson("POST", "/v1/index/cancel", { file_ids });
  }

  async resetIndex(file_id: string): Promise<{ reset: boolean }> {
    return this.requestJson("POST", `/v1/reset_index${this.qs({ file_id })}`);
  }

  async getDocumentStatus(file_id: string): Promise<DocumentStatus> {
    return this.requestJson("GET", `/v1/documents/${encodeURIComponent(file_id)}/status`);
  }

  async waitForIndexing(
    file_id: string,
    options?: { timeout?: number; interval?: number },
  ): Promise<DocumentStatus> {
    const timeout = options?.timeout ?? 600;
    const interval = options?.interval ?? 5;
    const start = Date.now();

    while ((Date.now() - start) / 1000 < timeout) {
      const status = await this.getDocumentStatus(file_id);
      if (status.ready || SUCCESS_STATUSES.has(status.status)) return status;
      if (FAILED_STATUSES.has(status.status)) {
        throw new DocWormError(422, `Indexing ${status.status}: ${status.error || file_id}`);
      }
      await new Promise((r) => setTimeout(r, interval * 1000));
    }
    throw new DocWormError(408, `Indexing timeout after ${timeout}s`);
  }

  async listDocuments(): Promise<Record<string, unknown>[]> {
    const d = await this.requestJson<{ documents: Record<string, unknown>[] }>("GET", "/v1/documents");
    return d.documents ?? [];
  }

  async deleteDocument(file_id: string): Promise<{ status: string }> {
    return this.requestJson("DELETE", `/v1/documents/${encodeURIComponent(file_id)}`);
  }

  /** Alias of deleteDocument via DELETE /v1/files/{file_id}. */
  async deleteFile(file_id: string): Promise<{ status: string }> {
    return this.requestJson("DELETE", `/v1/files/${encodeURIComponent(file_id)}`);
  }

  async reprocessDocument(file_id: string): Promise<{ status: string; file_id: string }> {
    return this.requestJson("POST", `/v1/documents/${encodeURIComponent(file_id)}/reprocess`);
  }

  async getDocumentTree(file_id: string, download = false): Promise<TreeNode[]> {
    const d = await this.requestJson<{ tree: TreeNode[] }>(
      "GET",
      `/v1/documents/${encodeURIComponent(file_id)}/tree${download ? "?download=true" : ""}`,
    );
    return d.tree ?? [];
  }

  async getNodeMap(file_id: string, download = false): Promise<Record<string, unknown>> {
    const d = await this.requestJson<{ node_map: Record<string, unknown> }>(
      "GET",
      `/v1/documents/${encodeURIComponent(file_id)}/node-map${download ? "?download=true" : ""}`,
    );
    return d.node_map ?? {};
  }

  async getDocumentPages(file_id: string): Promise<PageInfo[]> {
    const d = await this.requestJson<{ pages: PageInfo[] }>(
      "GET",
      `/v1/documents/${encodeURIComponent(file_id)}/pages`,
    );
    return d.pages ?? [];
  }

  async getPageContent(file_id: string, page_num: number): Promise<PageContent> {
    return this.requestJson(
      "GET",
      `/v1/documents/${encodeURIComponent(file_id)}/pages/${page_num}`,
    );
  }

  async getPageImage(file_id: string, page_num: number): Promise<PageImage> {
    const res = await fetch(
      `${this.baseUrl}/v1/documents/${encodeURIComponent(file_id)}/pages/${page_num}/image`,
      { headers: this.headers() },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new DocWormError(res.status, text);
    }
    return {
      content: await res.arrayBuffer(),
      contentType: res.headers.get("content-type") || "image/jpeg",
      totalPages: Number(res.headers.get("X-Total-Pages") || 0),
    };
  }

  async getOriginal(file_id: string): Promise<OriginalFile> {
    const res = await fetch(
      `${this.baseUrl}/v1/documents/${encodeURIComponent(file_id)}/original`,
      { headers: this.headers() },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new DocWormError(res.status, text);
    }
    return {
      content: await res.arrayBuffer(),
      contentType: res.headers.get("content-type") || "application/octet-stream",
      filename: res.headers.get("content-disposition") || "",
    };
  }

  async getExcelPreview(file_id: string): Promise<ExcelPreview> {
    return this.requestJson(
      "GET",
      `/v1/documents/${encodeURIComponent(file_id)}/excel-preview`,
    );
  }

  // ── Chats ──────────────────────────────────────────────────

  async createChat(
    chat_id: string,
    options?: { title?: string; display_name?: string; project_id?: string; model?: string },
  ): Promise<ChatInfo> {
    const body: Record<string, string> = { chatId: chat_id };
    if (options?.title) body.title = options.title;
    if (options?.display_name) body.display_name = options.display_name;
    if (options?.project_id) body.project_id = options.project_id;
    if (options?.model) body.model = options.model;
    return this.requestJson("POST", "/v1/chats/", body);
  }

  async listChats(): Promise<Record<string, unknown>[]> {
    const d = await this.requestJson<{ chats: Record<string, unknown>[] }>("GET", "/v1/chats/");
    return d.chats ?? [];
  }

  async getChat(chat_id: string): Promise<ChatInfo> {
    return this.requestJson("GET", `/v1/chats/${encodeURIComponent(chat_id)}`);
  }

  async updateChat(
    chat_id: string,
    fields: { title?: string; display_name?: string; model?: string },
  ): Promise<Record<string, unknown>> {
    return this.requestJson("PATCH", `/v1/chats/${encodeURIComponent(chat_id)}`, fields);
  }

  async deleteChat(chat_id: string): Promise<{ status: string }> {
    return this.requestJson("DELETE", `/v1/chats/${encodeURIComponent(chat_id)}`);
  }

  async attachDocuments(
    chat_id: string,
    file_ids: string[],
  ): Promise<{ chat_id: string; attachments: Record<string, unknown>[] }> {
    return this.requestJson("POST", `/v1/chats/${encodeURIComponent(chat_id)}/attach`, {
      file_ids,
    });
  }

  async detachDocument(
    chat_id: string,
    file_id: string,
  ): Promise<{ status: string }> {
    return this.requestJson("POST", `/v1/chats/${encodeURIComponent(chat_id)}/detach`, {
      file_id,
    });
  }

  async registerChatFile(body: {
    name: string;
    gcsPath: string;
    chatId: string;
    fileId?: string;
    title?: string;
    projectId?: string;
    size?: number;
    mimeType?: string;
  }): Promise<{ fileId: string; id: string }> {
    return this.requestJson("POST", "/v1/chat-files", body);
  }

  async getMessages(
    chat_id: string,
    options?: { limit?: number; parent_limit?: number; before?: string; before_id?: string },
  ): Promise<MessageList> {
    const params: Record<string, string | number> = { limit: options?.limit ?? 50 };
    if (options?.parent_limit !== undefined) params.parent_limit = options.parent_limit;
    if (options?.before) params.before = options.before;
    if (options?.before_id) params.before_id = options.before_id;
    return this.requestJson(
      "GET",
      `/v1/chats/${encodeURIComponent(chat_id)}/messages${this.qs(params)}`,
    );
  }

  async saveMessage(
    chat_id: string,
    body: {
      role: "user" | "assistant" | "system";
      content: string;
      attached_docs?: Record<string, unknown>[];
      parent_msg_id?: string;
      reasoning_content?: string;
      citations?: Record<string, unknown>[];
      usage?: Record<string, number>;
    },
  ): Promise<{ msg_id: string }> {
    return this.requestJson("POST", `/v1/chats/${encodeURIComponent(chat_id)}/messages`, body);
  }

  async editMessage(chat_id: string, msg_id: string, message: string, content?: string): Promise<Record<string, unknown>> {
    const body: Record<string, string> = {};
    if (message) body.message = message;
    if (content) body.content = content;
    if (Object.keys(body).length === 0) {
      throw new DocWormError(400, "editMessage requires message or content");
    }
    return this.requestJson(
      "PUT",
      `/v1/chats/${encodeURIComponent(chat_id)}/messages/${encodeURIComponent(msg_id)}`,
      body,
    );
  }

  async updateMessage(
    chat_id: string,
    msg_id: string,
    fields: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.requestJson(
      "PATCH",
      `/v1/chats/${encodeURIComponent(chat_id)}/messages/${encodeURIComponent(msg_id)}`,
      fields,
    );
  }

  async deleteMessage(chat_id: string, msg_id: string): Promise<Record<string, unknown>> {
    return this.requestJson(
      "DELETE",
      `/v1/chats/${encodeURIComponent(chat_id)}/messages/${encodeURIComponent(msg_id)}`,
    );
  }

  async cancelChatMessage(chat_id: string, msg_id: string): Promise<Record<string, unknown>> {
    return this.requestJson(
      "POST",
      `/v1/chats/${encodeURIComponent(chat_id)}/messages/${encodeURIComponent(msg_id)}/cancel`,
    );
  }

  async retryChatMessage(chat_id: string, msg_id: string, message?: string): Promise<Record<string, unknown>> {
    return this.requestJson(
      "POST",
      `/v1/chats/${encodeURIComponent(chat_id)}/messages/${encodeURIComponent(msg_id)}/retry`,
      message ? { message } : {},
    );
  }

  async getRunArtifact(chat_id: string, msg_id: string, artifact_id: string): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/chats/${encodeURIComponent(chat_id)}/messages/${encodeURIComponent(msg_id)}/run-artifacts/${encodeURIComponent(artifact_id)}`,
    );
  }

  async diagnoseMessage(chat_id: string, msg_id: string): Promise<Record<string, unknown>> {
    return this.requestJson(
      "GET",
      `/v1/chats/${encodeURIComponent(chat_id)}/messages/${encodeURIComponent(msg_id)}/diagnose`,
    );
  }

  async consolidateMemories(chat_id: string, llm = false): Promise<Record<string, unknown>> {
    return this.requestJson(
      "POST",
      `/v1/chats/${encodeURIComponent(chat_id)}/consolidate`,
      { llm },
    );
  }

  async downloadOutput(chat_id: string, session_id: string, filename: string): Promise<ArrayBuffer> {
    const res = await fetch(
      `${this.baseUrl}/v1/chats/${encodeURIComponent(chat_id)}/outputs/${encodeURIComponent(session_id)}/${encodeURIComponent(filename)}`,
      { headers: this.headers() },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new DocWormError(res.status, text);
    }
    return res.arrayBuffer();
  }

  async generateTitle(prompt: string): Promise<string> {
    const d = await this.requestJson<{ title: string }>("POST", "/v1/title", { prompt });
    return d.title ?? "";
  }

  // ── Chat streaming (WebSocket) ─────────────────────────────

  private mapWsEvent(event: string, data: unknown): ChatEvent | null {
    const d = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
    const text = typeof d.text === "string" ? d.text : "";

    switch (event) {
      case "thinking_chunk":
      case "thought":
        return { type: "thinking", text, data: d };
      case "answer_chunk":
        return { type: "answer", text, data: d };
      case "status_chunk":
        return { type: "status", text, data: d };
      case "citation":
        return { type: "citation", citation: ((d.citation ?? d) as ChatEvent["citation"]), data: d };
      case "action_start":
      case "action_complete":
        return { type: "action", text, data: d };
      case "trace_group":
      case "trace_group_end":
      case "trace_item":
      case "trace_item_update":
      case "thinking_phase_start":
      case "thinking_phase_end":
      case "nodes_selected":
      case "selected_sections":
      case "files_read":
      case "entity_discovered":
      case "subtasks_declared":
      case "subtask_start":
      case "subtask_action":
      case "subtask_complete":
      case "compaction":
        return { type: "trace", text, data: d };
      case "plan_update":
        return { type: "plan", data: d };
      case "todo_updated":
        return { type: "todo", data: d };
      case "traversal":
        return { type: "traversal", text, data: d };
      case "artifact_card":
      case "artifact.ready":
      case "artifact.created":
        return { type: "artifact", data: d };
      case "prediction_viz":
      case "excel_viz":
      case "viz":
        return { type: "viz", data: d };
      case "graph_status":
        return { type: "graph", text, data: d };
      case "work_completed":
        return { type: "work_completed", data: d };
      case "interrupted":
        return { type: "interrupted", data: d };
      case "done":
        return {
          type: "done",
          msg_id: typeof d.msg_id === "string" ? d.msg_id : undefined,
          usage: (d.usage ?? undefined) as ChatEvent["usage"],
          data: d,
        };
      case "error": {
        const err = d.error;
        return { type: "error", error: typeof err === "string" ? err : JSON.stringify(err ?? d), data: d };
      }
      default:
        // Liveness/housekeeping: thinking_start, working_start,
        // status_heartbeat, ping — not surfaced.
        return null;
    }
  }

  private async wsImpl(): Promise<typeof WebSocket> {
    const g = globalThis as { WebSocket?: typeof WebSocket };
    if (g.WebSocket) return g.WebSocket;
    const mod = await import("ws");
    return (mod.default ?? mod) as unknown as typeof WebSocket;
  }

  private async *wsStream(chat_id: string, frame: Record<string, unknown>): AsyncGenerator<ChatEvent> {
    const WS = await this.wsImpl();
    const ws = new WS(this.wsUrl(`/v1/chats/${encodeURIComponent(chat_id)}/chat`)) as WebSocket;

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new DocWormError(0, "WebSocket connection failed")), { once: true } as AddEventListenerOptions);
    });

    const queue: string[] = [];
    let closed = false;
    let notify: (() => void) | null = null;
    const wake = () => { const n = notify; notify = null; n?.(); };
    ws.addEventListener("message", (ev: MessageEvent) => {
      queue.push(String((ev as MessageEvent).data));
      wake();
    });
    ws.addEventListener("close", () => { closed = true; wake(); });
    ws.addEventListener("error", () => { closed = true; wake(); });

    const next = async (): Promise<string | null> => {
      for (;;) {
        const msg = queue.shift();
        if (msg !== undefined) return msg;
        if (closed) return null;
        await new Promise<void>((r) => { notify = r; });
      }
    };

    try {
      ws.send(JSON.stringify(this.wsAuthFrame()));
      const authRaw = await next();
      if (authRaw === null) {
        yield { type: "error", error: "WebSocket closed during auth" };
        return;
      }
      let authResp: Record<string, unknown>;
      try {
        authResp = JSON.parse(authRaw);
      } catch {
        yield { type: "error", error: "WebSocket auth: invalid response" };
        return;
      }
      if (authResp.type !== "auth_ok") {
        yield { type: "error", error: String(authResp.error ?? JSON.stringify(authResp)) };
        return;
      }

      ws.send(JSON.stringify(frame));

      for (;;) {
        const raw = await next();
        if (raw === null) return;
        let msg: { event?: string; data?: unknown };
        try {
          msg = JSON.parse(raw);
        } catch {
          continue;
        }
        const evt = this.mapWsEvent(msg.event ?? "", msg.data);
        if (!evt) continue;
        yield evt;
        if (evt.type === "done" || evt.type === "error") return;
      }
    } finally {
      try { ws.close(); } catch { /* already closed */ }
    }
  }

  /**
   * Stream a chat turn over WebSocket. Consume with `for await`.
   *
   * Call `retryChatMessage()` first when retrying an existing turn, and pass
   * the resulting parent/retry/base ids via options.
   */
  async *chatStream(
    chat_id: string,
    message: string,
    options?: ChatStreamOptions,
  ): AsyncGenerator<ChatEvent> {
    const frame: Record<string, unknown> = {
      type: "chat",
      message,
      orchestration: options?.orchestration ?? "auto",
    };
    if (options?.attached_docs) frame.attached_docs = options.attached_docs;
    if (options?.parent_msg_id) frame.parent_msg_id = options.parent_msg_id;
    if (options?.retry_msg_id) frame.retry_msg_id = options.retry_msg_id;
    if (options?.base_msg_id) frame.base_msg_id = options.base_msg_id;
    yield* this.wsStream(chat_id, frame);
  }

  /** Replay missed events of a previously-started stream. */
  async *chatReconnect(
    chat_id: string,
    msg_id: string,
    last_seq = -1,
  ): AsyncGenerator<ChatEvent> {
    yield* this.wsStream(chat_id, { type: "reconnect", msg_id, last_seq });
  }

  /** Cancel the current turn and start a new one. */
  async *chatInterrupt(
    chat_id: string,
    message: string,
    options?: Pick<ChatStreamOptions, "attached_docs" | "orchestration">,
  ): AsyncGenerator<ChatEvent> {
    const frame: Record<string, unknown> = {
      type: "chat_interrupt",
      message,
      orchestration: options?.orchestration ?? "auto",
    };
    if (options?.attached_docs) frame.attached_docs = options.attached_docs;
    yield* this.wsStream(chat_id, frame);
  }

  // ── Query ──────────────────────────────────────────────────

  async query(
    query_text: string,
    options?: QueryOptions,
  ): Promise<QueryResponse> {
    const body: Record<string, unknown> = { query: query_text };
    if (options?.file_id) body.file_id = options.file_id;
    if (options?.file_ids) body.file_ids = options.file_ids;
    if (options?.include_images) body.includeImages = true;
    if (options?.inline_images) body.inlineImages = true;
    if (options?.session_id) body.sessionId = options.session_id;
    if (options?.message_id) body.messageId = options.message_id;
    if (options?.root_collection) body.rootCollection = options.root_collection;
    const d = await this.requestJson<Record<string, unknown>>("POST", "/v1/query", body);
    return {
      answer: (d.answer as string) ?? "",
      citations: ((d.citations as []) ?? []) as QueryResponse["citations"],
      reasoning_traces: ((d.reasoning_traces as string[]) ?? []),
      sub_questions: ((d.sub_questions as string[]) ?? []),
      nodes_retrieved: Number(d.nodes_retrieved ?? 0),
      iterations: Number(d.iterations ?? 0),
    };
  }

  async cancelQuery(
    session_id: string,
    message_id: string,
    root_collection?: string,
  ): Promise<{ status: string }> {
    const body: Record<string, string> = { session_id, message_id };
    if (root_collection) body.root_collection = root_collection;
    return this.requestJson("POST", "/v1/query/cancel", body);
  }

  // ── Codegen ────────────────────────────────────────────────

  async codegenHealth(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/v1/codegen/health`);
    if (!res.ok) throw new DocWormError(res.status, await res.text().catch(() => ""));
    return res.json();
  }

  async generateCode(body: {
    chat_id: string;
    file_id: string;
    task?: "excel_index" | "scraper" | "generic";
    prompt?: string;
    output_hint?: string;
    entity_context?: string;
    exhaustive?: boolean;
    artifact_name?: string;
  }): Promise<CodegenResponse> {
    return this.requestJson("POST", "/v1/codegen/generate", {
      task: "excel_index",
      ...body,
    });
  }

  async listCodes(chat_id: string): Promise<Record<string, unknown>> {
    return this.requestJson("GET", `/v1/codegen/${encodeURIComponent(chat_id)}/codes`);
  }

  async getCode(
    chat_id: string,
    code_id: string,
    options?: { version?: number; latest?: boolean },
  ): Promise<Record<string, unknown>> {
    const params: Record<string, string | number> = {};
    if (options?.version !== undefined) params.version = options.version;
    if (options?.latest) params.latest = 1;
    return this.requestJson(
      "GET",
      `/v1/codegen/${encodeURIComponent(chat_id)}/code/${encodeURIComponent(code_id)}${this.qs(params)}`,
    );
  }

  async putCode(
    chat_id: string,
    code_id: string,
    body: { code: string; source?: string; explanation?: string; task?: string },
    options?: { fork?: boolean; version?: number },
  ): Promise<Record<string, unknown>> {
    const params: Record<string, string | number> = {};
    if (options?.fork) params.fork = 1;
    if (options?.version !== undefined) params.version = options.version;
    return this.requestJson(
      "PUT",
      `/v1/codegen/${encodeURIComponent(chat_id)}/code/${encodeURIComponent(code_id)}${this.qs(params)}`,
      body,
    );
  }

  async predict(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson("POST", "/v1/codegen/predict", body);
  }

  async getArtifact(chat_id: string, name: string): Promise<Record<string, unknown>> {
    return this.requestJson(
      "GET",
      `/v1/codegen/artifacts/${encodeURIComponent(chat_id)}/${encodeURIComponent(name)}`,
    );
  }

  // ── Tables / Models / Skills ───────────────────────────────

  async synthesizeTable(file_id: string, pages: number[]): Promise<Record<string, unknown>> {
    return this.requestJson("POST", "/v1/tables/synthesize", { file_id, pages });
  }

  async getToc(file_id: string): Promise<{ toc: unknown[]; table_groups: unknown[] }> {
    return this.requestJson("GET", `/v1/tables/toc/${encodeURIComponent(file_id)}`);
  }

  async listModels(): Promise<Record<string, unknown>> {
    return this.requestJson("GET", "/v1/models");
  }

  async generateSkill(prompt: string): Promise<Skill> {
    return this.requestJson("POST", "/v1/skills/generate", { prompt });
  }
}
