/**
 * Result of uploading a document to `POST /v1/upload`.
 */
export interface UploadResponse {
  /** Upload status reported by the API. */
  status: string;
  /** Server-assigned (or caller-supplied) document identifier. */
  file_id: string;
  /** Original filename recorded with the upload. */
  filename: string;
  /** Raw storage path of the uploaded bytes. */
  gcs_raw_path?: string;
}

/**
 * Result of queueing an indexing job.
 */
export interface IndexResponse {
  /** Indexing status, usually `"queued"` or `"completed"`. */
  status: string;
  /** Document identifier being indexed. */
  file_id: string;
  /** Original filename recorded with the document. */
  filename?: string;
  /** Total pages detected in the document. */
  total_pages?: number;
}

/**
 * Result of a batch reindex request.
 */
export interface IndexBatchResponse {
  /** Number of documents queued. */
  queued: number;
  /** Concurrency limit applied by the plan. */
  concurrency: number;
  /** Per-document results, keyed by file id. */
  results: Record<string, unknown>[];
}

/**
 * Result of retrying the failed pages of a partially indexed document.
 */
export interface RetryFailedResponse {
  /** Retry status reported by the API. */
  status: string;
  /** Document identifier. */
  file_id: string;
  /** Page numbers that were re-queued. */
  retried_pages: number[];
  /** Number of pages enqueued. */
  enqueued: number;
  /** Total pages in the document. */
  total_pages: number;
}

/**
 * Indexing status and progress of a document.
 */
export interface DocumentStatus {
  /** Document identifier. */
  fileId: string;
  /** Current status, for example `queued`, `indexing`, `ready`, or `error`. */
  status: string;
  /** True once indexing has completed successfully. */
  ready: boolean;
  /** Original filename. */
  filename: string;
  /** Total pages detected in the document. */
  totalPages: number;
  /** Pages processed so far. */
  processedPages: number;
  /** Completion percentage (0-100). */
  progressPct: number;
  /** Failure message when indexing failed. */
  error?: string;
  /** ISO timestamp when indexing started. */
  createdAt?: string;
  /** ISO timestamp when indexing finished. */
  completedAt?: string;
  /** Version identifier of the generated tree. */
  treeVersion?: string;
}

/**
 * A single page of a document with its extraction status.
 */
export interface PageInfo {
  /** 1-based page number. */
  page_num: number;
  /** Extraction status for the page. */
  status: string;
}

/**
 * Extracted markdown content for a single page.
 */
export interface PageContent {
  /** 1-based page number. */
  page_num: number;
  /** Extracted markdown for the page. */
  markdown: string;
  /** Extraction status for the page. */
  status: string;
}

/**
 * Rendered image bytes for a single page.
 */
export interface PageImage {
  /** Raw image bytes. */
  content: ArrayBuffer;
  /** MIME type of the image, for example `image/jpeg`. */
  contentType: string;
  /** Total pages in the document, from the `X-Total-Pages` header. */
  totalPages: number;
}

/**
 * The originally uploaded file.
 */
export interface OriginalFile {
  /** Raw file bytes. */
  content: ArrayBuffer;
  /** MIME type of the file. */
  contentType: string;
  /** `Content-Disposition` header value from the response. */
  filename: string;
}

/**
 * Header and first-row preview of a single Excel sheet.
 */
export interface ExcelSheetPreview {
  /** Sheet name. */
  name: string;
  /** Total rows in the sheet. */
  total_rows: number;
  /** Total columns in the sheet. */
  total_cols: number;
  /** Column header labels. */
  headers: string[];
  /** Preview rows, each an array of cell values. */
  preview_rows: unknown[][];
}

/**
 * Preview of every sheet in an Excel workbook.
 */
export interface ExcelPreview {
  /** Document identifier. */
  fileId: string;
  /** Original workbook filename. */
  filename: string;
  /** Per-sheet previews. */
  sheets: ExcelSheetPreview[];
}

/**
 * A node in a document's assembled knowledge-graph tree.
 */
export interface TreeNode {
  /** Stable node identifier. */
  node_id: string;
  /** Node title. */
  title?: string;
  /** Short summary of the node. */
  summary?: string;
  /** Full extracted text of the node. */
  text?: string;
  /** Source document type, for example `pdf` or `xlsx`. */
  source_type?: string;
  /** Section classification, for example `table` or `figure`. */
  section_type?: string;
  /** First page covered by the node. */
  start_page?: number;
  /** Last page covered by the node. */
  end_page?: number;
  /** Source filename. */
  filename?: string;
  /** Child nodes. */
  nodes?: TreeNode[];
}

/**
 * A document attached to a chat.
 */
export interface ChatAttachment {
  /** Document identifier. */
  fileId: string;
  /** Original filename. */
  filename?: string;
}

/**
 * Chat metadata.
 */
export interface ChatInfo {
  /** Internal record id. */
  id?: string;
  /** Chat identifier. */
  chatId?: string;
  /** Human-readable display name. */
  display_name?: string;
  /** camelCase alias of `display_name`. */
  displayName?: string;
  /** Chat title. */
  title?: string;
  /** Model override for the chat. */
  model?: string;
  /** Documents attached to the chat. */
  attachments?: ChatAttachment[];
  /** ISO timestamp when the chat was created. */
  created_at?: string;
}

/**
 * A source cited by a query answer or chat response.
 */
export interface Citation {
  /** Node identifier the citation points at. */
  node_id: string;
  /** Section or node title. */
  title: string;
  /** First page covered by the citation. */
  start_page: number;
  /** Last page covered by the citation. */
  end_page: number;
  /** Source filename. */
  filename: string;
  /** Document identifier. */
  fileId?: string;
  /** Excel sheet name, when the citation is a spreadsheet range. */
  sheet_name?: string;
  /** Section classification, for example `table`. */
  section_type?: string;
  /** Row range for spreadsheet citations. */
  row_range?: number[];
  /** Column range for spreadsheet citations. */
  col_range?: number[];
  /** Column headers for table citations. */
  column_headers?: string[];
  /** Source document type. */
  source_type?: string;
  /** Supporting text snippet. */
  snippet?: string;
  /** Signed URLs for cited images. */
  image_urls?: string[];
  /** Signed URLs for downloadable artifacts. */
  download_urls?: string[];
  /** Table identifier for table citations. */
  table_id?: string;
  /** Table description for table citations. */
  table_description?: string;
  /** Full table payloads. */
  tables?: Record<string, unknown>[];
  /** Full image payloads. */
  images?: Record<string, unknown>[];
}

/**
 * Token usage reported on a `done` chat event.
 */
export interface TokenUsage {
  /** Input/prompt tokens. */
  prompt_tokens: number;
  /** Output/completion tokens. */
  completion_tokens: number;
  /** Total tokens billed for the turn. */
  total_tokens: number;
  /** Number of model calls made for the turn. */
  calls: number;
  /** Tokens spent on reasoning/thinking. */
  thinking_tokens: number;
}

/**
 * A stored chat message.
 */
export interface Message {
  /** Message identifier. */
  msg_id: string;
  /** Alias of `msg_id`. */
  id?: string;
  /** Author role. */
  role: "user" | "assistant" | "system";
  /** Message text. */
  content: string;
  /** Thinking/reasoning trace text. */
  thinking?: string;
  /** Raw reasoning content. */
  reasoning_content?: string;
  /** Sources cited by the message. */
  citations?: Citation[];
  /** Reasoning steps recorded for the message. */
  steps?: Record<string, unknown>[];
  /** Tool or agent actions recorded for the message. */
  actions?: Record<string, unknown>[];
  /** Token usage for the message. */
  usage?: TokenUsage;
  /** Documents attached when the message was sent. */
  attached_docs?: Record<string, unknown>[];
  /** Parent message id in the conversation tree. */
  parent_msg_id?: string;
  /** Processing status of the message. */
  status?: string;
  /** ISO timestamp when the message was created. */
  created_at?: string;
}

/**
 * A page of chat message history.
 */
export interface MessageList {
  /** Messages in the page. */
  messages: Message[];
  /** True when older messages are available. */
  has_more: boolean;
}

/**
 * Event types emitted by the chat streams.
 */
export type ChatEventType =
  | "status"
  | "thinking"
  | "answer"
  | "citation"
  | "action"
  | "trace"
  | "plan"
  | "todo"
  | "traversal"
  | "artifact"
  | "viz"
  | "graph"
  | "work_completed"
  | "usage"
  | "interrupted"
  | "done"
  | "error";

/**
 * A single event from a chat stream (SSE or WebSocket).
 *
 * Events flow thinking -> answer -> citation* -> done/error; terminal events
 * carry usage (on `done`) or an error message (on `error`).
 */
export interface ChatEvent {
  /** Event type. */
  type: ChatEventType;
  /** Incremental text for text-bearing events. */
  text?: string;
  /** Source citation, on `citation` events. */
  citation?: Citation;
  /** Token usage, on `done` events. */
  usage?: TokenUsage;
  /** Error message, on `error` events. */
  error?: string;
  /** Message identifier, on `done` events. */
  msg_id?: string;
  /** Raw backend payload for the event. */
  data?: Record<string, unknown>;
}

/**
 * Response from a reasoning RAG query.
 */
export interface QueryResponse {
  /** Generated answer. */
  answer: string;
  /** Sources cited by the answer. */
  citations: Citation[];
  /** Reasoning traces produced during retrieval. */
  reasoning_traces: string[];
  /** Sub-questions the planner decomposed the query into. */
  sub_questions: string[];
  /** Number of graph nodes retrieved. */
  nodes_retrieved: number;
  /** Number of reasoning iterations performed. */
  iterations: number;
}

/**
 * Options for `DocWorm.query()`.
 */
export interface QueryOptions {
  /** Query a single document. */
  file_id?: string;
  /** Query several documents. */
  file_ids?: string[];
  /** Include image URLs in the response. */
  include_images?: boolean;
  /** Inline base64 images in the response. */
  inline_images?: boolean;
  /** Session id for conversation continuity. */
  session_id?: string;
  /** Message id the answer attaches to (enables persistence). */
  message_id?: string;
  /** Firestore root collection override. */
  root_collection?: string;
}

/**
 * Options for `DocWorm.chatStream()`.
 */
export interface ChatStreamOptions {
  /** Documents to scope the turn to; defaults to the chat's attachments. */
  attached_docs?: { id: string; name?: string }[];
  /** `auto` selects a strategy; `direct` skips orchestration. */
  orchestration?: "auto" | "direct";
  /** Parent message id for retry/edit context. */
  parent_msg_id?: string;
  /** Message id being retried. */
  retry_msg_id?: string;
  /** Base message id for edit context. */
  base_msg_id?: string;
}

/**
 * Options for `DocWorm.chatStreamSse()`.
 */
export interface ChatStreamSseOptions {
  /** Model override forwarded to the backend. */
  model?: string;
  /** `auto` selects a strategy; `direct` skips orchestration. */
  orchestration?: "auto" | "direct";
  /** Parent message id for retry/edit context. */
  parentMsgId?: string;
  /** Message id being retried. */
  retryMsgId?: string;
  /** Base message id for edit context. */
  baseMsgId?: string;
  /** Abort signal that cancels the stream. */
  signal?: AbortSignal;
}

/**
 * Options for `DocWorm.chatReconnectSse()`.
 */
export interface ChatReconnectSseOptions {
  /** Abort signal that cancels the stream. */
  signal?: AbortSignal;
}

/**
 * Result of a codegen request.
 */
export interface CodegenResponse {
  /** Persisted code artifact identifier. */
  code_id: string;
  /** Generated source code. */
  code: string;
  /** Explanation of the generated code. */
  explanation: string;
  /** Identifier of the execution run, when the code was executed. */
  run_id?: string;
  /** Execution output, when the code was executed. */
  output?: Record<string, unknown>;
}

/**
 * A generated custom skill.
 */
export interface Skill {
  /** Skill name. */
  name: string;
  /** Short description of the skill. */
  description: string;
  /** Instruction text the model follows when the skill is applied. */
  instruction: string;
}
