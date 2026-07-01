from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class CitedNode:
    node_id: str = ""
    title: str = ""
    start_page: int = 1
    end_page: int = 1
    filename: str = ""
    file_id: str = ""
    sheet_name: str = ""
    section_type: str = ""
    row_range: list[int] = field(default_factory=list)
    col_range: list[int] = field(default_factory=list)
    column_headers: list[str] = field(default_factory=list)
    source_type: str = "pdf"
    snippet: str = ""
    image_urls: list[str] = field(default_factory=list)
    download_urls: list[str] = field(default_factory=list)
    table_id: str = ""
    table_description: str = ""
    tables: list[dict] = field(default_factory=list)
    images: list[dict] = field(default_factory=list)


@dataclass
class UsageInfo:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


@dataclass
class ChatEvent:
    """A single event from a WebSocket chat stream.

    type is one of: status | thinking | answer | citation | action | trace |
    plan | todo | traversal | artifact | viz | graph | work_completed |
    usage | interrupted | done | error
    """

    type: str
    text: str = ""
    citation: Optional[CitedNode] = None
    usage: Optional[UsageInfo] = None
    error: str = ""
    msg_id: str = ""
    data: dict = field(default_factory=dict)


@dataclass
class UploadResponse:
    status: str
    file_id: str
    filename: str
    gcs_raw_path: str = ""


@dataclass
class IndexResponse:
    status: str
    file_id: str
    filename: str = ""
    total_pages: int = 0


@dataclass
class DocumentStatus:
    file_id: str
    status: str = ""
    ready: bool = False
    filename: str = ""
    total_pages: int = 0
    processed_pages: int = 0
    progress_pct: float = 0.0
    error: Optional[str] = None
    created_at: Optional[str] = None
    completed_at: Optional[str] = None
    tree_version: Optional[str] = None


@dataclass
class PageInfo:
    page_num: int
    status: str = "pending"


@dataclass
class PageContent:
    page_num: int
    markdown: str = ""
    status: str = ""


@dataclass
class ExcelSheetPreview:
    name: str = ""
    total_rows: int = 0
    total_cols: int = 0
    headers: list[str] = field(default_factory=list)
    preview_rows: list[list] = field(default_factory=list)


@dataclass
class TreeNode:
    node_id: str
    title: str = ""
    summary: str = ""
    text: str = ""
    source_type: str = ""
    section_type: str = ""
    start_page: int = 0
    end_page: int = 0
    filename: str = ""
    nodes: list["TreeNode"] = field(default_factory=list)


@dataclass
class ChatAttachment:
    file_id: str
    filename: str = ""


@dataclass
class ChatInfo:
    id: str = ""
    chat_id: str = ""
    display_name: str = ""
    title: str = ""
    model: str = ""
    attachments: list[dict] = field(default_factory=list)
    created_at: str = ""


@dataclass
class Message:
    msg_id: str = ""
    id: str = ""
    role: str = ""
    content: str = ""
    thinking: str = ""
    reasoning_content: str = ""
    citations: list[CitedNode] = field(default_factory=list)
    steps: list[dict] = field(default_factory=list)
    actions: list[dict] = field(default_factory=list)
    usage: UsageInfo = field(default_factory=UsageInfo)
    attached_docs: list[dict] = field(default_factory=list)
    parent_msg_id: str = ""
    status: str = ""
    created_at: str = ""


@dataclass
class QueryResponse:
    answer: str
    citations: list[CitedNode] = field(default_factory=list)
    reasoning_traces: list[str] = field(default_factory=list)
    sub_questions: list[str] = field(default_factory=list)
    nodes_retrieved: int = 0
    iterations: int = 0


@dataclass
class CodegenResponse:
    code_id: str
    code: str = ""
    explanation: str = ""
    run_id: Optional[str] = None
    output: dict = field(default_factory=dict)


@dataclass
class Skill:
    name: str
    description: str = ""
    instruction: str = ""


def cited_node_from_dict(d: dict) -> CitedNode:
    return CitedNode(
        node_id=d.get("node_id", ""),
        title=d.get("title", ""),
        start_page=d.get("start_page", 1),
        end_page=d.get("end_page", 1),
        filename=d.get("filename", ""),
        file_id=d.get("fileId", "") or d.get("file_id", ""),
        sheet_name=d.get("sheet_name", ""),
        section_type=d.get("section_type", ""),
        row_range=d.get("row_range", []) or [],
        col_range=d.get("col_range", []) or [],
        column_headers=d.get("column_headers", []) or [],
        source_type=d.get("source_type", "pdf"),
        snippet=d.get("snippet", ""),
        image_urls=d.get("image_urls", []) or [],
        download_urls=d.get("download_urls", []) or [],
        table_id=d.get("table_id", "") or d.get("tableId", ""),
        table_description=d.get("table_description", "") or d.get("description", ""),
        tables=d.get("tables", []) or [],
        images=d.get("images", []) or [],
    )


def message_from_dict(m: dict) -> "Message":
    usage = m.get("usage") or {}
    return Message(
        msg_id=m.get("msg_id", "") or m.get("id", ""),
        id=m.get("id", "") or m.get("msg_id", ""),
        role=m.get("role", ""),
        content=m.get("content", ""),
        thinking=m.get("thinking", ""),
        reasoning_content=m.get("reasoning_content", ""),
        citations=[cited_node_from_dict(c) for c in (m.get("citations") or [])],
        steps=m.get("steps") or m.get("reasoning_traces") or [],
        actions=m.get("actions") or [],
        usage=UsageInfo(
            prompt_tokens=usage.get("prompt_tokens", 0),
            completion_tokens=usage.get("completion_tokens", 0),
            total_tokens=usage.get("total_tokens", 0),
        ),
        attached_docs=m.get("attached_docs") or [],
        parent_msg_id=m.get("parent_msg_id", ""),
        status=m.get("status", ""),
        created_at=str(m.get("created_at", "") or ""),
    )


def document_status_from_dict(d: dict) -> DocumentStatus:
    return DocumentStatus(
        file_id=d.get("fileId", "") or d.get("file_id", ""),
        status=d.get("status", ""),
        ready=bool(d.get("ready", False)),
        filename=d.get("filename", ""),
        total_pages=d.get("totalPages", 0) or 0,
        processed_pages=d.get("processedPages", 0) or 0,
        progress_pct=d.get("progressPct", 0.0) or 0.0,
        error=d.get("error"),
        created_at=str(d["createdAt"]) if d.get("createdAt") else None,
        completed_at=str(d["completedAt"]) if d.get("completedAt") else None,
        tree_version=d.get("treeVersion"),
    )


def tree_node_from_dict(d: dict) -> TreeNode:
    return TreeNode(
        node_id=d.get("node_id", ""),
        title=d.get("title", ""),
        summary=d.get("summary", ""),
        text=d.get("text", ""),
        source_type=d.get("source_type", ""),
        section_type=d.get("section_type", ""),
        start_page=d.get("start_page", 0) or 0,
        end_page=d.get("end_page", 0) or 0,
        filename=d.get("filename", ""),
        nodes=[tree_node_from_dict(n) for n in (d.get("nodes") or [])],
    )


def _usage_from_dict(d: Any) -> UsageInfo:
    d = d or {}
    return UsageInfo(
        prompt_tokens=d.get("prompt_tokens", 0) or 0,
        completion_tokens=d.get("completion_tokens", 0) or 0,
        total_tokens=d.get("total_tokens", 0) or 0,
    )
