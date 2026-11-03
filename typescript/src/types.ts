export interface UploadResponse {
  status: string;
  file_id: string;
  filename: string;
  gcs_raw_path?: string;
}

export interface IndexResponse {
  status: string;
  file_id: string;
  filename?: string;
  total_pages?: number;
}

export interface IndexBatchResponse {
  queued: number;
  concurrency: number;
  results: Record<string, unknown>[];
}

export interface RetryFailedResponse {
  status: string;
  file_id: string;
  retried_pages: number[];
  enqueued: number;
  total_pages: number;
}

export interface DocumentStatus {
  fileId: string;
  status: string;
  ready: boolean;
  filename: string;
  totalPages: number;
  processedPages: number;
  progressPct: number;
  error?: string;
  createdAt?: string;
  completedAt?: string;
  treeVersion?: string;
}

export interface PageInfo {
  page_num: number;
  status: string;
}

export interface PageContent {
  page_num: number;
  markdown: string;
  status: string;
}

export interface PageImage {
  content: ArrayBuffer;
  contentType: string;
  totalPages: number;
}

export interface OriginalFile {
  content: ArrayBuffer;
  contentType: string;
  filename: string;
}

export interface ExcelSheetPreview {
  name: string;
  total_rows: number;
  total_cols: number;
  headers: string[];
  preview_rows: unknown[][];
}

export interface ExcelPreview {
  fileId: string;
  filename: string;
  sheets: ExcelSheetPreview[];
}

export interface TreeNode {
  node_id: string;
  title?: string;
  summary?: string;
  text?: string;
  source_type?: string;
  section_type?: string;
  start_page?: number;
  end_page?: number;
  filename?: string;
  nodes?: TreeNode[];
}

export interface ChatAttachment {
  fileId: string;
  filename?: string;
}

export interface ChatInfo {
  id?: string;
  chatId?: string;
  display_name?: string;
  displayName?: string;
  title?: string;
  model?: string;
  attachments?: ChatAttachment[];
  created_at?: string;
}

export interface Citation {
  node_id: string;
  title: string;
  start_page: number;
  end_page: number;
  filename: string;
  fileId?: string;
  sheet_name?: string;
  section_type?: string;
  row_range?: number[];
  col_range?: number[];
  column_headers?: string[];
  source_type?: string;
  snippet?: string;
  image_urls?: string[];
  download_urls?: string[];
  table_id?: string;
  table_description?: string;
  tables?: Record<string, unknown>[];
  images?: Record<string, unknown>[];
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  calls: number;
  thinking_tokens: number;
}

export interface Message {
  msg_id: string;
  id?: string;
  role: "user" | "assistant" | "system";
  content: string;
  thinking?: string;
  reasoning_content?: string;
  citations?: Citation[];
  steps?: Record<string, unknown>[];
  actions?: Record<string, unknown>[];
  usage?: TokenUsage;
  attached_docs?: Record<string, unknown>[];
  parent_msg_id?: string;
  status?: string;
  created_at?: string;
}

export interface MessageList {
  messages: Message[];
  has_more: boolean;
}

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

export interface ChatEvent {
  type: ChatEventType;
  text?: string;
  citation?: Citation;
  usage?: TokenUsage;
  error?: string;
  msg_id?: string;
  data?: Record<string, unknown>;
}

export interface QueryResponse {
  answer: string;
  citations: Citation[];
  reasoning_traces: string[];
  sub_questions: string[];
  nodes_retrieved: number;
  iterations: number;
}

export interface QueryOptions {
  file_id?: string;
  file_ids?: string[];
  include_images?: boolean;
  inline_images?: boolean;
  session_id?: string;
  message_id?: string;
  root_collection?: string;
}

export interface ChatStreamOptions {
  attached_docs?: { id: string; name?: string }[];
  orchestration?: "auto" | "direct";
  parent_msg_id?: string;
  retry_msg_id?: string;
  base_msg_id?: string;
}

export interface ChatStreamSseOptions {
  model?: string;
  orchestration?: "auto" | "direct";
  parentMsgId?: string;
  retryMsgId?: string;
  baseMsgId?: string;
  signal?: AbortSignal;
}

export interface ChatReconnectSseOptions {
  signal?: AbortSignal;
}

export interface CodegenResponse {
  code_id: string;
  code: string;
  explanation: string;
  run_id?: string;
  output?: Record<string, unknown>;
}

export interface Skill {
  name: string;
  description: string;
  instruction: string;
}
