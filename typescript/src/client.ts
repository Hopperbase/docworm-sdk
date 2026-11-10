import type {
  ChatEvent,
  ChatInfo,
  ChatReconnectSseOptions,
  ChatStreamOptions,
  ChatStreamSseOptions,
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
  TokenUsage,
  TreeNode,
  UploadResponse,
} from "./types.js";
import { resolveConfig, DocWormConfig } from "./config.js";

export type { DocWormConfig } from "./config.js";

/**
 * Error thrown for non-2xx DocWorm API responses and indexing failures.
 *
 * `status` is the HTTP status code returned by the API (or a synthetic code
 * such as 408 for a client-side indexing timeout) and `body` is the raw
 * response body.
 */
export class DocWormError extends Error {
  /** HTTP status code returned by the DocWorm API. */
  status: number;
  /** Raw response body returned by the DocWorm API. */
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

function normalizeUsage(raw: unknown): TokenUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const d = raw as Record<string, unknown>;
  const toInt = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
  const inputTokens = toInt(d.input_tokens ?? d.prompt_tokens);
  const outputTokens = toInt(d.output_tokens ?? d.completion_tokens);
  const totalTokens =
    d.total_tokens === undefined || d.total_tokens === null
      ? inputTokens + outputTokens
      : toInt(d.total_tokens);
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: totalTokens,
    calls: toInt(d.calls),
    thinking_tokens: toInt(d.thinking_tokens),
  };
}

/**
 * Official TypeScript client for the DocWorm API: document indexing,
 * knowledge graphs, reasoning RAG queries, and streaming chat.
 *
 * @example
 * ```ts
 * const client = new DocWorm({ apiKey: "dw_live_..." });
 * const upload = await client.upload("report.pdf");
 * await client.uploadAndIndex("report.pdf");
 * ```
 */
export class DocWorm {
  private baseUrl: string;
  private apiKey: string;

  /**
   * Create a DocWorm client.
   *
   * Configuration resolves in order: constructor options, then the
   * `DOCWORM_API_KEY` / `DOCWORM_URL` environment variables, then `config.yaml`.
   *
   * @param config - API key and base URL overrides. `apiKey` and `baseUrl` are camelCase aliases.
   */
  constructor(config: DocWormConfig = {}) {
    const cfg = resolveConfig(config);
    this.baseUrl = cfg.base_url.replace(/\/$/, "");
    this.apiKey = cfg.api_key;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey.startsWith("dw_live_")) h["X-API-KEY"] = this.apiKey;
    else if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
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
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        ...this.headers(),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
    };
    if (signal) init.signal = signal;
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

  /**
   * Public low-level HTTP escape hatch for endpoints the SDK doesn't wrap.
   * The base URL and auth header are applied automatically.
   *
   * @param method - HTTP method.
   * @param path - Path appended to the configured base URL.
   * @param options - Query `params`, JSON `json` body, and a `timeout` in seconds.
   * @returns Parsed JSON response body (empty object on 204/empty body).
   * @throws DocWormError on a non-2xx response.
   */
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
        options?.timeout ? ctrl.signal : undefined,
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

  /**
   * Upload a document to be indexed.
   *
   * @param file - File path (Node), `Buffer`, or web `File`.
   * @param options - Optional filename override, custom `file_id`, and scoping ids (`project_id`, `chat_id`, `folder_id`).
   * @returns Upload response containing the `file_id` used for indexing.
   */
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

  /**
   * Index an already-uploaded document, or upload and index in one step by
   * passing `options.file`.
   *
   * @param file_id - Document identifier from `upload()`.
   * @param options - Scoping ids and an optional `file` to upload with the request.
   * @returns Index response, usually with `status: "queued"`; poll with {@link waitForIndexing}.
   */
  async index(
    file_id: string,
    options?: { project_id?: string; chat_id?: string; folder_id?: string; file?: File | Buffer | string; filename?: string },
  ): Promise<IndexResponse> {
    const query = this.qs({ file_id });
    if (!options?.file) {
      const form = new FormData();
      let hasFields = false;
      if (options?.project_id) {
        form.append("project_id", options.project_id);
        hasFields = true;
      }
      if (options?.chat_id) {
        form.append("chat_id", options.chat_id);
        hasFields = true;
      }
      if (options?.folder_id) {
        form.append("folder_id", options.folder_id);
        hasFields = true;
      }
      const init: RequestInit = { method: "POST", headers: this.headers() };
      if (hasFields) init.body = form;
      const res = await fetch(`${this.baseUrl}/v1/index${query}`, init);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new DocWormError(res.status, text);
      }
      return res.json() as Promise<IndexResponse>;
    }
    // One-step upload + index.
    const form = new FormData();
    const { blob, filename: detected } = await this.toBlob(options.file);
    form.append("file", blob, options.filename || detected);
    const res = await fetch(`${this.baseUrl}/v1/index${query}`, {
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

  /**
   * Upload a document and immediately queue it for indexing.
   *
   * @param file - File path (Node), `Buffer`, or web `File`.
   * @param options - Optional filename override, custom `file_id`, and scoping ids.
   * @returns Queued index response; use {@link waitForIndexing} to wait for completion.
   */
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

  /**
   * Index a pre-built document tree JSON directly (programmatic ingestion).
   *
   * @param file_id - Document identifier to associate with the tree.
   * @param tree - Array of tree nodes to index.
   * @param filename - Display filename recorded with the document.
   * @returns Index response, usually with `status: "completed"`.
   */
  async indexJson(file_id: string, tree: Record<string, unknown>[], filename = "document.json"): Promise<IndexResponse> {
    return this.requestJson("POST", "/v1/index-json", { file_id, filename, tree });
  }

  /**
   * Queue batch reindexing for up to 100 documents, gated by plan concurrency.
   *
   * @param file_ids - Document identifiers to reindex.
   * @returns Queued count, concurrency, and per-file results.
   */
  async indexBatch(file_ids: string[]): Promise<IndexBatchResponse> {
    return this.requestJson("POST", "/v1/index/batch", { file_ids });
  }

  /**
   * Re-queue only the failed pages of a partially indexed document.
   *
   * @param file_id - Document identifier.
   * @returns Retried page numbers, enqueued count, and total page count.
   */
  async retryFailedPages(file_id: string): Promise<RetryFailedResponse> {
    return this.requestJson("POST", `/v1/index/retry-failed${this.qs({ file_id })}`);
  }

  /**
   * Cancel in-flight indexing tasks for one or more documents.
   *
   * @param file_ids - Document identifiers whose indexing should be cancelled.
   * @returns Number of cancelled tasks.
   */
  async cancelIndexing(file_ids: string[]): Promise<{ cancelled: number }> {
    return this.requestJson("POST", "/v1/index/cancel", { file_ids });
  }

  /**
   * Wipe derived indexing state for a document without uploading new bytes
   * (used by the replace flow).
   *
   * @param file_id - Document identifier.
   * @returns `{ reset: true }` when the state was cleared.
   */
  async resetIndex(file_id: string): Promise<{ reset: boolean }> {
    return this.requestJson("POST", `/v1/reset_index${this.qs({ file_id })}`);
  }

  /**
   * Get the indexing status and progress of a document.
   *
   * @param file_id - Document identifier.
   * @returns Status including `status`, `ready`, processed pages, and any error.
   */
  async getDocumentStatus(file_id: string): Promise<DocumentStatus> {
    return this.requestJson("GET", `/v1/documents/${encodeURIComponent(file_id)}/status`);
  }

  /**
   * Poll document status until indexing completes, fails, or times out.
   *
   * @param file_id - Document identifier.
   * @param options - `timeout` in seconds (default 600) and poll `interval` in seconds (default 5).
   * @returns The terminal document status.
   * @throws DocWormError with status 422 when indexing fails or is cancelled, 408 on timeout.
   */
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

  /**
   * List all documents owned by the authenticated user.
   *
   * @returns Array of document summary records.
   */
  async listDocuments(): Promise<Record<string, unknown>[]> {
    const d = await this.requestJson<{ documents: Record<string, unknown>[] }>("GET", "/v1/documents");
    return d.documents ?? [];
  }

  /**
   * Delete a document and all of its derived artifacts.
   *
   * @param file_id - Document identifier.
   * @returns Deletion status.
   */
  async deleteDocument(file_id: string): Promise<{ status: string }> {
    return this.requestJson("DELETE", `/v1/documents/${encodeURIComponent(file_id)}`);
  }

  /**
   * Alias of {@link deleteDocument} that deletes via `DELETE /v1/files/{file_id}`.
   *
   * @param file_id - Document identifier.
   * @returns Deletion status.
   */
  async deleteFile(file_id: string): Promise<{ status: string }> {
    return this.requestJson("DELETE", `/v1/files/${encodeURIComponent(file_id)}`);
  }

  /**
   * Reprocess an entire document, redoing extraction from the original file.
   *
   * @param file_id - Document identifier.
   * @returns Status and the document identifier.
   */
  async reprocessDocument(file_id: string): Promise<{ status: string; file_id: string }> {
    return this.requestJson("POST", `/v1/documents/${encodeURIComponent(file_id)}/reprocess`);
  }

  /**
   * Get the assembled document tree.
   *
   * @param file_id - Document identifier.
   * @param download - When true, request the downloadable tree variant.
   * @returns Root tree nodes.
   */
  async getDocumentTree(file_id: string, download = false): Promise<TreeNode[]> {
    const d = await this.requestJson<{ tree: TreeNode[] }>(
      "GET",
      `/v1/documents/${encodeURIComponent(file_id)}/tree${download ? "?download=true" : ""}`,
    );
    return d.tree ?? [];
  }

  /**
   * Get the flat node-id to node map for a document.
   *
   * @param file_id - Document identifier.
   * @param download - When true, request the downloadable variant.
   * @returns Map of node id to node payload.
   */
  async getNodeMap(file_id: string, download = false): Promise<Record<string, unknown>> {
    const d = await this.requestJson<{ node_map: Record<string, unknown> }>(
      "GET",
      `/v1/documents/${encodeURIComponent(file_id)}/node-map${download ? "?download=true" : ""}`,
    );
    return d.node_map ?? {};
  }

  /**
   * List every page of a document with its extraction status.
   *
   * @param file_id - Document identifier.
   * @returns Page numbers and statuses.
   */
  async getDocumentPages(file_id: string): Promise<PageInfo[]> {
    const d = await this.requestJson<{ pages: PageInfo[] }>(
      "GET",
      `/v1/documents/${encodeURIComponent(file_id)}/pages`,
    );
    return d.pages ?? [];
  }

  /**
   * Get the extracted markdown content for a single page.
   *
   * @param file_id - Document identifier.
   * @param page_num - 1-based page number.
   * @returns Page markdown and status.
   */
  async getPageContent(file_id: string, page_num: number): Promise<PageContent> {
    return this.requestJson(
      "GET",
      `/v1/documents/${encodeURIComponent(file_id)}/pages/${page_num}`,
    );
  }

  /**
   * Fetch the rendered image bytes for a single page.
   *
   * @param file_id - Document identifier.
   * @param page_num - 1-based page number.
   * @returns Image bytes, content type, and total page count from `X-Total-Pages`.
   */
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

  /**
   * Download the original uploaded file.
   *
   * @param file_id - Document identifier.
   * @returns File bytes, content type, and the `Content-Disposition` header.
   */
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

  /**
   * Preview every sheet of an Excel workbook (headers and first rows).
   *
   * @param file_id - Document identifier.
   * @returns Workbook filename and per-sheet previews.
   */
  async getExcelPreview(file_id: string): Promise<ExcelPreview> {
    return this.requestJson(
      "GET",
      `/v1/documents/${encodeURIComponent(file_id)}/excel-preview`,
    );
  }

  // ── Chats ──────────────────────────────────────────────────

  /**
   * Create a chat. Idempotent: returns the existing chat when the id is taken.
   *
   * @param chat_id - Client-chosen chat identifier.
   * @param options - Optional title, display name, project scope, and model override.
   * @returns Chat metadata.
   */
  async createChat(
    chat_id: string,
    options?: { title?: string; display_name?: string; project_id?: string; model?: string },
  ): Promise<ChatInfo> {
    const body: Record<string, string> = { chatId: chat_id };
    if (options?.title) body.title = options.title;
    if (options?.display_name) body.display_name = options.display_name;
    if (options?.project_id) body.project_id = options.project_id;
    if (options?.model) body.model = options.model;
    return this.requestJson("POST", "/v1/chats", body);
  }

  /**
   * List all chats for the current user.
   *
   * @returns Array of chat summary records.
   */
  async listChats(): Promise<Record<string, unknown>[]> {
    const d = await this.requestJson<{ chats: Record<string, unknown>[] }>("GET", "/v1/chats");
    return d.chats ?? [];
  }

  /**
   * Get chat details.
   *
   * @param chat_id - Chat identifier.
   * @returns Chat metadata.
   */
  async getChat(chat_id: string): Promise<ChatInfo> {
    return this.requestJson("GET", `/v1/chats/${encodeURIComponent(chat_id)}`);
  }

  /**
   * Update chat metadata.
   *
   * @param chat_id - Chat identifier.
   * @param fields - Fields to change: `title`, `display_name`, or `model`.
   * @returns Updated chat record.
   */
  async updateChat(
    chat_id: string,
    fields: { title?: string; display_name?: string; model?: string },
  ): Promise<Record<string, unknown>> {
    return this.requestJson("PATCH", `/v1/chats/${encodeURIComponent(chat_id)}`, fields);
  }

  /**
   * Delete a chat and its message history.
   *
   * @param chat_id - Chat identifier.
   * @returns Deletion status.
   */
  async deleteChat(chat_id: string): Promise<{ status: string }> {
    return this.requestJson("DELETE", `/v1/chats/${encodeURIComponent(chat_id)}`);
  }

  /**
   * Attach indexed documents to a chat, rebuilding its knowledge graph.
   *
   * @param chat_id - Chat identifier.
   * @param file_ids - Document identifiers to attach.
   * @returns Chat id and the attachment list.
   */
  async attachDocuments(
    chat_id: string,
    file_ids: string[],
  ): Promise<{ chat_id: string; attachments: Record<string, unknown>[] }> {
    return this.requestJson("POST", `/v1/chats/${encodeURIComponent(chat_id)}/attach`, {
      file_ids,
    });
  }

  /**
   * Remove a document attachment from a chat.
   *
   * @param chat_id - Chat identifier.
   * @param file_id - Document identifier to detach.
   * @returns Detach status.
   */
  async detachDocument(
    chat_id: string,
    file_id: string,
  ): Promise<{ status: string }> {
    return this.requestJson("POST", `/v1/chats/${encodeURIComponent(chat_id)}/detach`, {
      file_id,
    });
  }

  /**
   * Register a chat-uploaded file and enqueue indexing in the background.
   *
   * @param body - File name, GCS path, chat and file ids, plus optional title, project, size, and MIME type.
   * @returns The registered `fileId` and record `id`.
   */
  async registerChatFile(body: {
    name: string;
    gcsPath: string;
    chatId: string;
    fileId: string;
    title?: string;
    projectId?: string;
    size?: number;
    mimeType?: string;
  }): Promise<{ fileId: string; id: string }> {
    return this.requestJson("POST", "/v1/chat-files", body);
  }

  /**
   * Get chat message history.
   *
   * @param chat_id - Chat identifier.
   * @param options - `limit` (default 50) plus optional `parent_limit` and cursor pairs (`before`, `before_id`).
   * @returns Messages and a `has_more` flag.
   */
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

  /**
   * Save a chat message with the given role.
   *
   * @param chat_id - Chat identifier.
   * @param body - Message role, content, and optional attachments, parent id, reasoning, citations, and usage.
   * @returns The new `msg_id`.
   */
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

  /**
   * Edit a user message before retry (`PUT`). Requires `message` or `content`.
   *
   * @param chat_id - Chat identifier.
   * @param msg_id - Message identifier.
   * @param message - Replacement message text.
   * @param content - Replacement content, when editing the stored content field.
   * @returns Updated message record.
   */
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

  /**
   * Patch a message's content or structure.
   *
   * @param chat_id - Chat identifier.
   * @param msg_id - Message identifier.
   * @param fields - Fields to patch.
   * @returns Updated message record.
   */
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

  /**
   * Delete a message from chat history.
   *
   * @param chat_id - Chat identifier.
   * @param msg_id - Message identifier.
   * @returns Deletion result.
   */
  async deleteMessage(chat_id: string, msg_id: string): Promise<Record<string, unknown>> {
    return this.requestJson(
      "DELETE",
      `/v1/chats/${encodeURIComponent(chat_id)}/messages/${encodeURIComponent(msg_id)}`,
    );
  }

  /**
   * Cancel an actively streaming chat message.
   *
   * @param chat_id - Chat identifier.
   * @param msg_id - Streaming message identifier.
   * @returns Cancellation result.
   */
  async cancelChatMessage(chat_id: string, msg_id: string): Promise<Record<string, unknown>> {
    return this.requestJson(
      "POST",
      `/v1/chats/${encodeURIComponent(chat_id)}/messages/${encodeURIComponent(msg_id)}/cancel`,
    );
  }

  /**
   * Prepare a user message for retry. Call this before opening a retry stream
   * with the returned parent/retry ids.
   *
   * @param chat_id - Chat identifier.
   * @param msg_id - Message identifier to retry.
   * @param message - Optional replacement message text.
   * @returns Retry context for the next stream.
   */
  async retryChatMessage(chat_id: string, msg_id: string, message?: string): Promise<Record<string, unknown>> {
    return this.requestJson(
      "POST",
      `/v1/chats/${encodeURIComponent(chat_id)}/messages/${encodeURIComponent(msg_id)}/retry`,
      message ? { message } : {},
    );
  }

  /**
   * Download a run artifact payload (for example an extraction result JSON).
   *
   * @param chat_id - Chat identifier.
   * @param msg_id - Message identifier that produced the artifact.
   * @param artifact_id - Artifact identifier.
   * @returns Artifact payload.
   */
  async getRunArtifact(chat_id: string, msg_id: string, artifact_id: string): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/chats/${encodeURIComponent(chat_id)}/messages/${encodeURIComponent(msg_id)}/run-artifacts/${encodeURIComponent(artifact_id)}`,
    );
  }

  /**
   * Inspect a streaming or completed message (steps, citations, buffer state).
   *
   * @param chat_id - Chat identifier.
   * @param msg_id - Message identifier.
   * @returns Diagnostic record.
   */
  async diagnoseMessage(chat_id: string, msg_id: string): Promise<Record<string, unknown>> {
    return this.requestJson(
      "GET",
      `/v1/chats/${encodeURIComponent(chat_id)}/messages/${encodeURIComponent(msg_id)}/diagnose`,
    );
  }

  /**
   * Consolidate unconsolidated session memories for a chat.
   *
   * @param chat_id - Chat identifier.
   * @param llm - When true, use the LLM-assisted consolidation pass.
   * @returns Consolidation result.
   */
  async consolidateMemories(chat_id: string, llm = false): Promise<Record<string, unknown>> {
    return this.requestJson(
      "POST",
      `/v1/chats/${encodeURIComponent(chat_id)}/consolidate`,
      { llm },
    );
  }

  /**
   * Download an archived structured-output file.
   *
   * @param chat_id - Chat identifier.
   * @param session_id - Session that produced the output.
   * @param filename - Archived file name.
   * @returns File bytes.
   */
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

  /**
   * Generate a short chat title from a user prompt.
   *
   * @param prompt - User prompt to summarize.
   * @returns Generated title, or an empty string when none is returned.
   */
  async generateTitle(prompt: string): Promise<string> {
    const d = await this.requestJson<{ title: string }>("POST", "/v1/title", { prompt });
    return d.title ?? "";
  }

  // ── Chat streaming (WebSocket + SSE) ───────────────────────

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
          usage: normalizeUsage(d.usage),
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
   * Reserved for direct-to-service deployments; cannot connect through the hosted
   * service - use {@link chatStreamSse} there.
   *
   * Call {@link retryChatMessage} first when retrying an existing turn, and pass
   * the resulting parent/retry/base ids via options.
   *
   * @param chat_id - Chat identifier.
   * @param message - User message; empty for retries driven by ids alone.
   * @param options - Attached documents, orchestration mode, and retry/edit ids.
   * @returns Async generator of chat events (thinking, answer, citations, done or error).
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

  /**
   * Replay missed events of a previously-started WebSocket stream.
   *
   * Reserved for direct-to-service deployments; cannot connect through the hosted
   * service - use {@link chatReconnectSse} there.
   *
   * @param chat_id - Chat identifier.
   * @param msg_id - Streaming message identifier.
   * @param last_seq - Last sequence number already received.
   * @returns Async generator of chat events.
   */
  async *chatReconnect(
    chat_id: string,
    msg_id: string,
    last_seq = -1,
  ): AsyncGenerator<ChatEvent> {
    yield* this.wsStream(chat_id, { type: "reconnect", msg_id, last_seq });
  }

  /**
   * Cancel the current turn and start a new one seeded with a plan.
   *
   * Reserved for direct-to-service deployments; cannot connect through the hosted
   * service - use {@link chatStreamSse} there.
   *
   * @param chat_id - Chat identifier.
   * @param message - New user message.
   * @param options - Attached documents and orchestration mode.
   * @returns Async generator of chat events.
   */
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

  private mapSsePayload(payload: string): ChatEvent | null {
    let frame: unknown;
    try {
      frame = JSON.parse(payload);
    } catch {
      return null;
    }
    if (typeof frame !== "object" || frame === null) return null;
    const f = frame as { event?: unknown; data?: unknown };
    const event = typeof f.event === "string" ? f.event : "";
    return this.mapWsEvent(event, f.data);
  }

  private async *sseStream(
    chat_id: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    const res = await fetch(
      `${this.baseUrl}/v1/chats/${encodeURIComponent(chat_id)}/stream`,
      {
        method: "POST",
        headers: {
          ...this.headers(),
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new DocWormError(res.status, text.slice(0, 300));
    }
    if (!res.body) {
      throw new DocWormError(res.status, "SSE response has no body");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];

    const handleLine = (rawLine: string): ChatEvent | null => {
      let line = rawLine;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (dataLines.length === 0) return null;
        const payload = dataLines.join("\n");
        dataLines = [];
        return this.mapSsePayload(payload);
      }
      if (line.startsWith(":") || !line.startsWith("data:")) return null;
      let value = line.slice(5);
      if (value.startsWith(" ")) value = value.slice(1);
      dataLines.push(value);
      return null;
    };

    const cancel = async (): Promise<void> => {
      try {
        await reader.cancel();
      } catch {
        /* stream already closed */
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (buffer.length > 0) {
            const evt = handleLine(buffer);
            buffer = "";
            if (evt) {
              yield evt;
              if (evt.type === "done" || evt.type === "error") {
                await cancel();
                return;
              }
            }
          }
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const evt = handleLine(line);
          if (evt) {
            yield evt;
            if (evt.type === "done" || evt.type === "error") {
              await cancel();
              return;
            }
          }
          newline = buffer.indexOf("\n");
        }
      }
      // Flush a final event that arrived without a blank line.
      if (dataLines.length > 0) {
        const evt = this.mapSsePayload(dataLines.join("\n"));
        if (evt) yield evt;
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Stream a chat turn over SSE. Use this when a WebSocket upgrade is
   * unavailable (the hosted service); events and terminal semantics match
   * {@link chatStream}.
   *
   * Call {@link retryChatMessage} first when retrying an existing turn, and pass
   * the resulting parent/retry/base ids via options.
   *
   * @param chatId - Chat identifier.
   * @param message - User message; empty for retries driven by ids alone.
   * @param opts - Model override, orchestration mode, retry/edit ids, and an abort `signal`.
   * @returns Async generator of chat events.
   */
  async *chatStreamSse(
    chatId: string,
    message: string,
    opts?: ChatStreamSseOptions,
  ): AsyncGenerator<ChatEvent> {
    const body: Record<string, unknown> = { type: "chat", message };
    if (opts?.model) body.model = opts.model;
    if (opts?.orchestration) body.orchestration = opts.orchestration;
    if (opts?.parentMsgId) body.parent_msg_id = opts.parentMsgId;
    if (opts?.retryMsgId) body.retry_msg_id = opts.retryMsgId;
    if (opts?.baseMsgId) body.base_msg_id = opts.baseMsgId;
    yield* this.sseStream(chatId, body, opts?.signal);
  }

  /**
   * Replay missed events over SSE. Mirrors {@link chatReconnect}.
   *
   * @param chatId - Chat identifier.
   * @param msgId - Streaming message identifier.
   * @param lastSeq - Last sequence number already received.
   * @param opts - Optional abort `signal`.
   * @returns Async generator of chat events.
   */
  async *chatReconnectSse(
    chatId: string,
    msgId: string,
    lastSeq = -1,
    opts?: ChatReconnectSseOptions,
  ): AsyncGenerator<ChatEvent> {
    yield* this.sseStream(
      chatId,
      { type: "reconnect", msg_id: msgId, last_seq: lastSeq },
      opts?.signal,
    );
  }

  // ── Query ──────────────────────────────────────────────────

  /**
   * Run a reasoning RAG query over one or more indexed documents.
   *
   * @param query_text - The question to answer.
   * @param options - Document scope, image handling, session/message continuity, and collection override.
   * @returns Answer, citations, reasoning traces, retrieved node count, and iteration count.
   */
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

  /**
   * Cancel an active reasoning query.
   *
   * @param session_id - Session that owns the query.
   * @param message_id - Message the query is answering.
   * @param root_collection - Optional Firestore root collection override.
   * @returns Cancellation status.
   */
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

  /**
   * Check codegen service health (no auth required).
   *
   * @returns Health payload.
   */
  async codegenHealth(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/v1/codegen/health`);
    if (!res.ok) throw new DocWormError(res.status, await res.text().catch(() => ""));
    return res.json();
  }

  /**
   * Generate code for a document; for `excel_index` the generated code is also executed.
   *
   * @param body - Chat and document ids, task type, and optional prompt, output hint, entity context, exhaustive flag, and artifact name.
   * @returns Generated code, explanation, and any run output.
   */
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

  /**
   * List generated code artifacts for a chat.
   *
   * @param chat_id - Chat identifier.
   * @returns Code artifact listing.
   */
  async listCodes(chat_id: string): Promise<Record<string, unknown>> {
    return this.requestJson("GET", `/v1/codegen/${encodeURIComponent(chat_id)}/codes`);
  }

  /**
   * Fetch a persisted code artifact.
   *
   * @param chat_id - Chat identifier.
   * @param code_id - Code artifact identifier.
   * @param options - Optional `version` or `latest` selector.
   * @returns Code artifact record.
   */
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

  /**
   * Persist a modified code artifact. Set `options.fork` to fork to a new id.
   *
   * @param chat_id - Chat identifier.
   * @param code_id - Code artifact identifier.
   * @param body - Code, explanation, and optional source or task metadata.
   * @param options - Optional `fork` flag and `version` selector.
   * @returns Updated code artifact record.
   */
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

  /**
   * Forward a tabular prediction request to the predictor service.
   *
   * @param body - Predictor payload.
   * @returns Prediction result.
   */
  async predict(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson("POST", "/v1/codegen/predict", body);
  }

  /**
   * Download a persisted named artifact (JSON inline, `.xlsx` by reference).
   *
   * @param chat_id - Chat identifier.
   * @param name - Artifact name.
   * @returns Artifact record.
   */
  async getArtifact(chat_id: string, name: string): Promise<Record<string, unknown>> {
    return this.requestJson(
      "GET",
      `/v1/codegen/artifacts/${encodeURIComponent(chat_id)}/${encodeURIComponent(name)}`,
    );
  }

  // ── Tables / Models / Skills ───────────────────────────────

  /**
   * Synthesize a table from selected document pages.
   *
   * @param file_id - Document identifier.
   * @param pages - Page numbers to synthesize from.
   * @returns Synthesized table payload.
   */
  async synthesizeTable(file_id: string, pages: number[]): Promise<Record<string, unknown>> {
    return this.requestJson("POST", "/v1/tables/synthesize", { file_id, pages });
  }

  /**
   * Get a document's table of contents and sequential table groups.
   *
   * @param file_id - Document identifier.
   * @returns TOC entries and table groups.
   */
  async getToc(file_id: string): Promise<{ toc: unknown[]; table_groups: unknown[] }> {
    return this.requestJson("GET", `/v1/tables/toc/${encodeURIComponent(file_id)}`);
  }

  /**
   * Get public model provenance and per-section default models.
   *
   * @returns Model registry payload.
   */
  async listModels(): Promise<Record<string, unknown>> {
    return this.requestJson("GET", "/v1/models");
  }

  /**
   * Generate a custom skill from a natural-language description.
   *
   * @param prompt - Description of the desired skill.
   * @returns Generated skill name, description, and instruction.
   */
  async generateSkill(prompt: string): Promise<Skill> {
    return this.requestJson("POST", "/v1/skills/generate", { prompt });
  }
}
