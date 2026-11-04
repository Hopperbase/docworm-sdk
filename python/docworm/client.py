"""
DocWorm Python SDK (0.6.1).

Thin client over the DocWorm REST API plus the chat streams (WebSocket and
SSE). Covers documents, chats, reasoning RAG queries, codegen, tables, models,
and titles.

Canonical identifiers are file_id (document) and chat_id (chat).
Chat streaming is available over WebSocket (chat_stream) and over SSE
(chat_stream_sse) for deployments where a WebSocket upgrade is unavailable.

Configuration priority (highest first):
  1. Constructor arguments
  2. Environment variables (DOCWORM_API_KEY, DOCWORM_URL)
  3. config.yaml file (optional, see project root)

Auth accepts a DocWorm API key (dw_live_...), sent as ``X-API-KEY: <key>``
with no Authorization header, or a bearer token, sent as
``Authorization: Bearer <token>``.
"""

import json
import logging
import os
from typing import Any, AsyncGenerator, BinaryIO, Optional, Union
from urllib.parse import quote

import httpx

from .config import load_config
from .models import (
    ChatAttachment,
    ChatEvent,
    ChatInfo,
    CitedNode,
    CodegenResponse,
    DocumentStatus,
    ExcelSheetPreview,
    IndexResponse,
    Message,
    PageContent,
    PageInfo,
    QueryResponse,
    Skill,
    TreeNode,
    UploadResponse,
    UsageInfo,
    _usage_from_dict,
    cited_node_from_dict,
    document_status_from_dict,
    message_from_dict,
    tree_node_from_dict,
)

logger = logging.getLogger(__name__)

# Terminal statuses on the file row — wait_for_indexing stops polling.
_SUCCESS_STATUSES = ("ready", "completed", "indexed")
_FAILED_STATUSES = ("error", "failed", "cancelled")


def _normalize_chat_data(data: Any) -> dict:
    """Normalize a WS/SSE ``data`` payload to a dict.

    The backend may deliver data as an object or as a JSON string.
    """
    if isinstance(data, dict):
        return data
    if isinstance(data, str):
        try:
            parsed = json.loads(data)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def _map_chat_event(event: str, data: Any) -> Optional[ChatEvent]:
    """Map a backend chat event (WS or SSE) to a ChatEvent.

    Shared by the WebSocket and SSE transports; returns None for
    liveness/housekeeping events that are not surfaced.
    """
    d = _normalize_chat_data(data)
    text = d.get("text", "") if isinstance(d.get("text"), str) else ""

    if event == "thinking_chunk" or event == "thought":
        return ChatEvent(type="thinking", text=text, data=d)
    if event == "answer_chunk":
        return ChatEvent(type="answer", text=text, data=d)
    if event == "status_chunk":
        return ChatEvent(type="status", text=text, data=d)
    if event == "citation":
        cit = d.get("citation", d)
        citation = cited_node_from_dict(cit if isinstance(cit, dict) else {})
        return ChatEvent(type="citation", citation=citation, data=d)
    if event in ("action_start", "action_complete"):
        return ChatEvent(type="action", text=text, data=d)
    if event in (
        "trace_group", "trace_group_end", "trace_item", "trace_item_update",
        "thinking_phase_start", "thinking_phase_end", "nodes_selected",
        "selected_sections", "files_read", "entity_discovered",
        "subtasks_declared", "subtask_start", "subtask_action",
        "subtask_complete", "compaction",
    ):
        return ChatEvent(type="trace", text=text, data=d)
    if event == "plan_update":
        return ChatEvent(type="plan", data=d)
    if event == "todo_updated":
        return ChatEvent(type="todo", data=d)
    if event == "traversal":
        return ChatEvent(type="traversal", text=text, data=d)
    if event in ("artifact_card", "artifact.ready", "artifact.created"):
        return ChatEvent(type="artifact", data=d)
    if event in ("prediction_viz", "excel_viz", "viz"):
        return ChatEvent(type="viz", data=d)
    if event == "graph_status":
        return ChatEvent(type="graph", text=text, data=d)
    if event == "work_completed":
        return ChatEvent(type="work_completed", data=d)
    if event == "interrupted":
        return ChatEvent(type="interrupted", data=d)
    if event == "done":
        return ChatEvent(
            type="done",
            msg_id=d.get("msg_id", ""),
            usage=_usage_from_dict(d.get("usage")),
            data=d,
        )
    if event == "error":
        err = d.get("error", "")
        return ChatEvent(type="error", error=err if isinstance(err, str) else str(err), data=d)
    # Liveness/housekeeping: thinking_start, working_start,
    # status_heartbeat, ping — not surfaced.
    return None


class DocWorm:
    """
    SDK client for the DocWorm service.

    Args:
        base_url: DocWorm service URL (default: DOCWORM_URL env > config.yaml > hosted).
        api_key: DocWorm API key, dw_live_... (default: DOCWORM_API_KEY env > config.yaml).

    Usage:
        client = DocWorm(api_key="...")
        upload = client.upload("report.pdf")
        client.index(upload.file_id)
        status = client.wait_for_indexing(upload.file_id)
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
    ):
        cfg = load_config(api_key=api_key, base_url=base_url)
        self.base_url = cfg["base_url"].rstrip("/")
        self.api_key = cfg["api_key"]
        if not self.api_key:
            self._headers = {}
        elif self.api_key.startswith("dw_live_"):
            self._headers = {"X-API-KEY": self.api_key}
        else:
            self._headers = {"Authorization": f"Bearer {self.api_key}"}

    # ── low-level ────────────────────────────────────────────────────

    def _raw_request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[dict] = None,
        json: Optional[dict] = None,
        data: Optional[dict] = None,
        files: Optional[dict] = None,
        timeout: float = 60,
    ) -> dict:
        """Public low-level HTTP escape hatch for endpoints the SDK doesn't wrap.

        URLs are joined with ``base_url``; the auth header is injected
        automatically.

        Returns:
            Parsed JSON body as dict (or empty dict on 204/empty body).
        """
        resp = httpx.request(
            method,
            f"{self.base_url}{path}",
            params=params,
            json=json,
            data=data,
            files=files,
            headers=self._headers,
            timeout=timeout,
        )
        resp.raise_for_status()
        if resp.status_code == 204 or not resp.content:
            return {}
        return resp.json()

    def _ws_url(self, path: str) -> str:
        base = self.base_url.replace("https://", "wss://").replace("http://", "ws://")
        return f"{base}{path}"

    def _ws_auth_frame(self) -> dict:
        # dw_live_ keys go in api_key; bearer tokens go in token.
        if (self.api_key or "").startswith("dw_live_"):
            return {"type": "auth", "api_key": self.api_key}
        return {"type": "auth", "token": self.api_key}

    # ════════════════════════════════════════════════════════════════════════
    # DOCUMENTS
    # ════════════════════════════════════════════════════════════════════════

    @staticmethod
    def _read_file(file: Union[str, bytes, BinaryIO], filename: Optional[str] = None):
        if isinstance(file, str):
            with open(file, "rb") as f:
                content = f.read()
            filename = filename or os.path.basename(file)
        elif isinstance(file, bytes):
            content = file
        else:
            content = file.read()
            filename = filename or getattr(file, "name", "document")
        return content, filename

    def upload(
        self,
        file: Union[str, bytes, BinaryIO],
        filename: Optional[str] = None,
        file_id: Optional[str] = None,
        project_id: Optional[str] = None,
        chat_id: Optional[str] = None,
        folder_id: Optional[str] = None,
    ) -> UploadResponse:
        """
        Upload a document for indexing.

        Args:
            file: File path (str), raw bytes, or file-like object.
            filename: Original filename (auto-detected from path if str).
            file_id: Optional custom file ID (server generates one otherwise).
            project_id, chat_id, folder_id: Optional scoping context.

        Returns:
            UploadResponse with file_id for subsequent indexing.
        """
        content, filename = self._read_file(file, filename)
        files = {"file": (filename, content, "application/octet-stream")}
        data = {}
        if file_id:
            data["file_id"] = file_id
        if project_id:
            data["project_id"] = project_id
        if chat_id:
            data["chat_id"] = chat_id
        if folder_id:
            data["folder_id"] = folder_id

        resp = httpx.post(
            f"{self.base_url}/v1/upload",
            files=files,
            data=data,
            headers=self._headers,
            timeout=300,
        )
        resp.raise_for_status()
        d = resp.json()
        return UploadResponse(
            status=d.get("status", ""),
            file_id=d.get("file_id", ""),
            filename=d.get("filename", ""),
            gcs_raw_path=d.get("gcs_raw_path", ""),
        )

    def index(
        self,
        file_id: str,
        project_id: Optional[str] = None,
        chat_id: Optional[str] = None,
        folder_id: Optional[str] = None,
        file: Optional[Union[str, bytes, BinaryIO]] = None,
        filename: Optional[str] = None,
    ) -> IndexResponse:
        """
        Index an already-uploaded document (or upload + index in one step
        by passing ``file``).

        ``file_id`` is sent as a query parameter; the optional scoping
        fields are still form fields.

        Returns:
            IndexResponse — usually ``status="queued"``; poll with
            wait_for_indexing() until ready.
        """
        params = {"file_id": file_id}
        data: dict = {}
        if project_id:
            data["project_id"] = project_id
        if chat_id:
            data["chat_id"] = chat_id
        if folder_id:
            data["folder_id"] = folder_id
        files = None
        if file is not None:
            content, filename = self._read_file(file, filename)
            files = {"file": (filename, content, "application/octet-stream")}

        resp = httpx.post(
            f"{self.base_url}/v1/index",
            params=params,
            data=data,
            files=files,
            headers=self._headers,
            timeout=60,
        )
        resp.raise_for_status()
        d = resp.json()
        return IndexResponse(
            status=d.get("status", ""),
            file_id=d.get("file_id", file_id),
            filename=d.get("filename", ""),
            total_pages=d.get("total_pages", 0) or 0,
        )

    def upload_and_index(
        self,
        file: Union[str, bytes, BinaryIO],
        filename: Optional[str] = None,
        file_id: Optional[str] = None,
        project_id: Optional[str] = None,
        chat_id: Optional[str] = None,
        folder_id: Optional[str] = None,
    ) -> IndexResponse:
        """
        Upload and immediately index a document (convenience method).

        Returns the queued IndexResponse — call wait_for_indexing() to
        block until the document is ready.
        """
        upload_resp = self.upload(
            file, filename=filename, file_id=file_id,
            project_id=project_id, chat_id=chat_id, folder_id=folder_id,
        )
        return self.index(
            upload_resp.file_id,
            project_id=project_id, chat_id=chat_id, folder_id=folder_id,
        )

    def index_json(
        self,
        file_id: str,
        tree: list[dict],
        filename: str = "document.json",
    ) -> IndexResponse:
        """
        Index a pre-built tree JSON directly (programmatic ingestion).

        Returns:
            IndexResponse with status="completed".
        """
        resp = httpx.post(
            f"{self.base_url}/v1/index-json",
            json={"file_id": file_id, "filename": filename, "tree": tree},
            headers=self._headers,
            timeout=60,
        )
        resp.raise_for_status()
        d = resp.json()
        return IndexResponse(
            status=d.get("status", ""),
            file_id=d.get("file_id", file_id),
            filename=d.get("filename", ""),
            total_pages=d.get("total_pages", 0) or 0,
        )

    def index_batch(self, file_ids: list[str]) -> dict:
        """
        Batch reindex up to 100 files (concurrency-gated by plan).

        Returns:
            Dict with queued count, concurrency, and per-file results.
        """
        resp = httpx.post(
            f"{self.base_url}/v1/index/batch",
            json={"file_ids": file_ids},
            headers=self._headers,
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json()

    def retry_failed_pages(self, file_id: str) -> dict:
        """
        Re-queue only the failed pages of a partial document.

        Returns:
            Dict with retried_pages, enqueued count, and total_pages.
        """
        resp = httpx.post(
            f"{self.base_url}/v1/index/retry-failed",
            params={"file_id": file_id},
            headers=self._headers,
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json()

    def cancel_indexing(self, file_ids: list[str]) -> dict:
        """
        Cancel in-flight indexing tasks for documents.

        Returns:
            Dict with cancelled task count.
        """
        resp = httpx.post(
            f"{self.base_url}/v1/index/cancel",
            json={"file_ids": file_ids},
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    def reset_index(self, file_id: str) -> dict:
        """
        Wipe derived state for a doc without uploading new bytes
        (used by the replace flow).

        Returns:
            Dict with reset bool.
        """
        resp = httpx.post(
            f"{self.base_url}/v1/reset_index",
            params={"file_id": file_id},
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    def list_documents(self) -> list[dict]:
        """List all documents for the authenticated user."""
        resp = httpx.get(
            f"{self.base_url}/v1/documents",
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json().get("documents", [])

    def get_document_status(self, file_id: str) -> DocumentStatus:
        """
        Get the indexing status and progress of a document.
        """
        resp = httpx.get(
            f"{self.base_url}/v1/documents/{quote(file_id)}/status",
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        return document_status_from_dict(resp.json())

    def wait_for_indexing(
        self,
        file_id: str,
        timeout: float = 600,
        poll_interval: float = 5,
    ) -> DocumentStatus:
        """
        Poll until document indexing completes or times out.

        Raises:
            RuntimeError: If indexing fails or is cancelled.
            TimeoutError: If indexing doesn't complete in time.
        """
        import time

        deadline = time.time() + timeout
        while time.time() < deadline:
            status = self.get_document_status(file_id)
            if status.ready or status.status in _SUCCESS_STATUSES:
                return status
            if status.status in _FAILED_STATUSES:
                raise RuntimeError(f"Indexing {status.status}: {status.error or file_id}")
            time.sleep(poll_interval)
        raise TimeoutError(f"Indexing not complete after {timeout}s")

    def get_document_pages(self, file_id: str) -> list[PageInfo]:
        """
        List all pages of a document with their extraction status.
        """
        resp = httpx.get(
            f"{self.base_url}/v1/documents/{quote(file_id)}/pages",
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        pages = resp.json().get("pages", [])
        return [PageInfo(page_num=p["page_num"], status=p.get("status", "")) for p in pages]

    def get_page_content(self, file_id: str, page_num: int) -> PageContent:
        """
        Get the extracted markdown content for a single page.
        """
        resp = httpx.get(
            f"{self.base_url}/v1/documents/{quote(file_id)}/pages/{page_num}",
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        d = resp.json()
        return PageContent(
            page_num=d.get("page_num", page_num),
            markdown=d.get("markdown", ""),
            status=d.get("status", ""),
        )

    def get_page_image(self, file_id: str, page_num: int) -> dict:
        """
        Get the JPEG bytes for a single page.

        Returns:
            Dict with content (bytes), content_type, and total_pages
            (from the X-Total-Pages response header).
        """
        resp = httpx.get(
            f"{self.base_url}/v1/documents/{quote(file_id)}/pages/{page_num}/image",
            headers=self._headers,
            timeout=60,
        )
        resp.raise_for_status()
        return {
            "content": resp.content,
            "content_type": resp.headers.get("content-type", "image/jpeg"),
            "total_pages": int(resp.headers.get("X-Total-Pages", 0) or 0),
        }

    def get_original(self, file_id: str) -> dict:
        """
        Download the original uploaded file.

        Returns:
            Dict with content (bytes), content_type, and filename.
        """
        resp = httpx.get(
            f"{self.base_url}/v1/documents/{quote(file_id)}/original",
            headers=self._headers,
            timeout=120,
        )
        resp.raise_for_status()
        return {
            "content": resp.content,
            "content_type": resp.headers.get("content-type", "application/octet-stream"),
            "filename": resp.headers.get("content-disposition", ""),
        }

    def get_document_tree(self, file_id: str, download: bool = False) -> list[TreeNode]:
        """
        Get the assembled document tree.
        """
        params = {"download": "true"} if download else None
        resp = httpx.get(
            f"{self.base_url}/v1/documents/{quote(file_id)}/tree",
            params=params,
            headers=self._headers,
            timeout=60,
        )
        resp.raise_for_status()
        return [tree_node_from_dict(n) for n in resp.json().get("tree", [])]

    def get_node_map(self, file_id: str, download: bool = False) -> dict:
        """
        Get the flat node-id → node map for a document.
        """
        params = {"download": "true"} if download else None
        resp = httpx.get(
            f"{self.base_url}/v1/documents/{quote(file_id)}/node-map",
            params=params,
            headers=self._headers,
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json().get("node_map", {})

    def get_excel_preview(self, file_id: str) -> dict:
        """
        Preview every sheet of an Excel file (headers + first rows).

        Returns:
            Dict with fileId, filename, and sheets list.
        """
        resp = httpx.get(
            f"{self.base_url}/v1/documents/{quote(file_id)}/excel-preview",
            headers=self._headers,
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json()

    def delete_document(self, file_id: str) -> dict:
        """
        Delete a document and all its artifacts (GCS, Firestore).
        """
        resp = httpx.delete(
            f"{self.base_url}/v1/documents/{quote(file_id)}",
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    def delete_file(self, file_id: str) -> dict:
        """
        Alias of delete_document via DELETE /v1/files/{file_id}.
        """
        resp = httpx.delete(
            f"{self.base_url}/v1/files/{quote(file_id)}",
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    def reprocess_document(self, file_id: str) -> dict:
        """
        Reprocess an entire document (redo extraction).
        """
        resp = httpx.post(
            f"{self.base_url}/v1/documents/{quote(file_id)}/reprocess",
            headers=self._headers,
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json()

    # ════════════════════════════════════════════════════════════════════════
    # CHATS
    # ════════════════════════════════════════════════════════════════════════

    def create_chat(
        self,
        chat_id: str,
        title: str = "",
        display_name: str = "",
        project_id: str = "",
        model: str = "",
    ) -> ChatInfo:
        """
        Create a new chat. Idempotent — returns the existing chat id
        when it already exists.
        """
        body: dict = {"chatId": chat_id}
        if title:
            body["title"] = title
        if display_name:
            body["display_name"] = display_name
        if project_id:
            body["project_id"] = project_id
        if model:
            body["model"] = model
        resp = httpx.post(
            f"{self.base_url}/v1/chats",
            json=body,
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        d = resp.json()
        return ChatInfo(
            id=d.get("id", chat_id),
            chat_id=chat_id,
            display_name=d.get("display_name", ""),
            created_at=str(d.get("created_at", "") or ""),
        )

    def get_chat(self, chat_id: str) -> dict:
        """Get chat details."""
        resp = httpx.get(
            f"{self.base_url}/v1/chats/{quote(chat_id)}",
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    def update_chat(
        self,
        chat_id: str,
        title: Optional[str] = None,
        display_name: Optional[str] = None,
        model: Optional[str] = None,
    ) -> dict:
        """Update chat metadata (title, display_name, model)."""
        body: dict = {}
        if title is not None:
            body["title"] = title
        if display_name is not None:
            body["display_name"] = display_name
        if model is not None:
            body["model"] = model
        resp = httpx.patch(
            f"{self.base_url}/v1/chats/{quote(chat_id)}",
            json=body,
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    def delete_chat(self, chat_id: str) -> dict:
        """Delete a chat and its message history."""
        resp = httpx.delete(
            f"{self.base_url}/v1/chats/{quote(chat_id)}",
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    def list_chats(self) -> list[dict]:
        """List all chats for the current user."""
        resp = httpx.get(
            f"{self.base_url}/v1/chats",
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json().get("chats", [])

    def attach_documents(self, chat_id: str, file_ids: list[str]) -> dict:
        """
        Attach indexed documents to a chat. Rebuilds the chat's
        knowledge graph.

        Returns:
            Dict with chat_id and attachments list.
        """
        resp = httpx.post(
            f"{self.base_url}/v1/chats/{quote(chat_id)}/attach",
            json={"file_ids": file_ids},
            headers=self._headers,
            timeout=120,
        )
        resp.raise_for_status()
        return resp.json()

    def detach_document(self, chat_id: str, file_id: str) -> dict:
        """Remove a document attachment from a chat."""
        resp = httpx.post(
            f"{self.base_url}/v1/chats/{quote(chat_id)}/detach",
            json={"file_id": file_id},
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    def register_chat_file(
        self,
        name: str,
        gcs_path: str,
        chat_id: str,
        file_id: str,
        title: Optional[str] = None,
        project_id: Optional[str] = None,
        size: int = 0,
        mime_type: str = "",
    ) -> dict:
        """
        Register a chat-uploaded file and enqueue indexing in the background.

        ``file_id`` is required and always sent as ``fileId``.

        Returns:
            Dict with fileId and id.
        """
        body: dict = {
            "name": name,
            "gcsPath": gcs_path,
            "chatId": chat_id,
            "fileId": file_id,
        }
        if title:
            body["title"] = title
        if project_id:
            body["projectId"] = project_id
        if size:
            body["size"] = size
        if mime_type:
            body["mimeType"] = mime_type
        resp = httpx.post(
            f"{self.base_url}/v1/chat-files",
            json=body,
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    # ── messages ─────────────────────────────────────────────────────

    def get_messages(
        self,
        chat_id: str,
        limit: int = 50,
        parent_limit: Optional[int] = None,
        before: Optional[str] = None,
        before_id: Optional[str] = None,
    ) -> dict:
        """
        Get chat message history.

        Returns:
            Dict with messages (list[Message]) and has_more (bool).
        """
        params: dict = {"limit": limit}
        if parent_limit is not None:
            params["parent_limit"] = parent_limit
        if before:
            params["before"] = before
        if before_id:
            params["before_id"] = before_id
        resp = httpx.get(
            f"{self.base_url}/v1/chats/{quote(chat_id)}/messages",
            params=params,
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        d = resp.json()
        messages = [message_from_dict(m) for m in d.get("messages", [])]
        return {"messages": messages, "has_more": bool(d.get("has_more", False))}

    def save_message(
        self,
        chat_id: str,
        role: str,
        content: str,
        attached_docs: Optional[list] = None,
        parent_msg_id: str = "",
        reasoning_content: str = "",
        citations: Optional[list] = None,
        usage: Optional[dict] = None,
    ) -> dict:
        """
        Save a chat message (role: user | assistant | system).

        Returns:
            Dict with msg_id.
        """
        body: dict = {"role": role, "content": content}
        if attached_docs:
            body["attached_docs"] = attached_docs
        if parent_msg_id:
            body["parent_msg_id"] = parent_msg_id
        if reasoning_content:
            body["reasoning_content"] = reasoning_content
        if citations:
            body["citations"] = citations
        if usage:
            body["usage"] = usage
        resp = httpx.post(
            f"{self.base_url}/v1/chats/{quote(chat_id)}/messages",
            json=body,
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    def edit_message(
        self, chat_id: str, msg_id: str, message: str = "", content: str = ""
    ) -> dict:
        """Edit a user message before retry (PUT). Accepts message or content."""
        body: dict = {}
        if message:
            body["message"] = message
        if content:
            body["content"] = content
        if not body:
            raise ValueError("edit_message requires message or content")
        resp = httpx.put(
            f"{self.base_url}/v1/chats/{quote(chat_id)}/messages/{quote(msg_id)}",
            json=body,
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    def update_message(self, chat_id: str, msg_id: str, fields: dict) -> dict:
        """Patch message content/structure (PATCH)."""
        resp = httpx.patch(
            f"{self.base_url}/v1/chats/{quote(chat_id)}/messages/{quote(msg_id)}",
            json=fields,
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    def delete_message(self, chat_id: str, msg_id: str) -> dict:
        """Delete a message from chat history."""
        resp = httpx.delete(
            f"{self.base_url}/v1/chats/{quote(chat_id)}/messages/{quote(msg_id)}",
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    def cancel_chat_message(self, chat_id: str, msg_id: str) -> dict:
        """Cancel an actively-streaming chat message."""
        resp = httpx.post(
            f"{self.base_url}/v1/chats/{quote(chat_id)}/messages/{quote(msg_id)}/cancel",
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    def retry_chat_message(self, chat_id: str, msg_id: str, message: str = "") -> dict:
        """
        Prepare a user message for retry. Call before opening a
        WS retry stream with parent_msg_id/retry_msg_id.
        """
        resp = httpx.post(
            f"{self.base_url}/v1/chats/{quote(chat_id)}/messages/{quote(msg_id)}/retry",
            json={"message": message} if message else {},
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    def get_run_artifact(self, chat_id: str, msg_id: str, artifact_id: str) -> dict:
        """Download a run artifact payload (e.g. extraction result JSON)."""
        resp = httpx.get(
            f"{self.base_url}/v1/chats/{quote(chat_id)}/messages/{quote(msg_id)}"
            f"/run-artifacts/{quote(artifact_id)}",
            headers=self._headers,
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json()

    def diagnose_message(self, chat_id: str, msg_id: str) -> dict:
        """Inspect a streaming/completed message (steps, citations, buffer)."""
        resp = httpx.get(
            f"{self.base_url}/v1/chats/{quote(chat_id)}/messages/{quote(msg_id)}/diagnose",
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    def consolidate_memories(self, chat_id: str, llm: bool = False) -> dict:
        """Consolidate unconsolidated session memories for a chat."""
        resp = httpx.post(
            f"{self.base_url}/v1/chats/{quote(chat_id)}/consolidate",
            json={"llm": llm},
            headers=self._headers,
            timeout=120,
        )
        resp.raise_for_status()
        return resp.json()

    def download_output(self, chat_id: str, session_id: str, filename: str) -> bytes:
        """Download an archived structured-output file."""
        resp = httpx.get(
            f"{self.base_url}/v1/chats/{quote(chat_id)}/outputs/"
            f"{quote(session_id)}/{quote(filename)}",
            headers=self._headers,
            timeout=120,
        )
        resp.raise_for_status()
        return resp.content

    def generate_title(self, prompt: str) -> str:
        """Generate a short title from a user prompt."""
        resp = httpx.post(
            f"{self.base_url}/v1/title",
            json={"prompt": prompt},
            headers=self._headers,
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json().get("title", "")

    # ════════════════════════════════════════════════════════════════════════
    # CHAT (WebSocket + SSE streaming)
    # ════════════════════════════════════════════════════════════════════════

    @staticmethod
    def _normalize_ws_data(data: Any) -> dict:
        return _normalize_chat_data(data)

    @classmethod
    def _map_ws_event(cls, event: str, data: Any) -> Optional[ChatEvent]:
        """Map a backend WS event to a ChatEvent. Returns None to skip."""
        return _map_chat_event(event, data)

    async def _ws_stream(
        self, chat_id: str, request_frame: dict
    ) -> AsyncGenerator[ChatEvent, None]:
        try:
            import websockets
        except ImportError as e:
            raise RuntimeError(
                "WebSocket chat requires the 'websockets' package: pip install websockets"
            ) from e

        url = self._ws_url(f"/v1/chats/{quote(chat_id)}/chat")
        async with websockets.connect(url, max_size=16 * 1024 * 1024) as ws:
            await ws.send(json.dumps(self._ws_auth_frame()))
            try:
                raw = await ws.recv()
            except Exception as e:
                yield ChatEvent(type="error", error=f"WS auth failed: {e}")
                return
            try:
                auth_resp = json.loads(raw)
            except json.JSONDecodeError:
                yield ChatEvent(type="error", error="WS auth: invalid response")
                return
            if auth_resp.get("type") != "auth_ok":
                yield ChatEvent(
                    type="error",
                    error=str(auth_resp.get("error", auth_resp)),
                )
                return

            await ws.send(json.dumps(request_frame))
            async for raw_msg in ws:
                try:
                    msg = json.loads(raw_msg)
                except json.JSONDecodeError:
                    continue
                event = msg.get("event", "")
                evt = self._map_ws_event(event, msg.get("data", {}))
                if evt is None:
                    continue
                yield evt
                if evt.type in ("done", "error"):
                    return

    def chat_stream(
        self,
        chat_id: str,
        message: str,
        attached_docs: Optional[list] = None,
        orchestration: str = "auto",
        parent_msg_id: str = "",
        retry_msg_id: str = "",
        base_msg_id: str = "",
    ) -> AsyncGenerator[ChatEvent, None]:
        """
        Stream a chat turn over WebSocket.

        Args:
            chat_id: Chat identifier.
            message: User message (empty for pure retries driven by ids).
            attached_docs: [{"id": file_id, "name": ...}] — defaults to the
                chat's attachments server-side when omitted.
            orchestration: "auto" (strategy-based) or "direct".
            parent_msg_id, retry_msg_id, base_msg_id: retry/edit context —
                call retry_chat_message() first for retries.

        Yields:
            ChatEvent objects (thinking → answer → citation* → done/error).
            Consume with ``async for``.
        """
        frame: dict = {
            "type": "chat",
            "message": message,
            "orchestration": orchestration,
        }
        if attached_docs:
            frame["attached_docs"] = attached_docs
        if parent_msg_id:
            frame["parent_msg_id"] = parent_msg_id
        if retry_msg_id:
            frame["retry_msg_id"] = retry_msg_id
        if base_msg_id:
            frame["base_msg_id"] = base_msg_id
        return self._ws_stream(chat_id, frame)

    def chat_reconnect(
        self, chat_id: str, msg_id: str, last_seq: int = -1
    ) -> AsyncGenerator[ChatEvent, None]:
        """
        Replay missed events of a previously-started stream.
        """
        return self._ws_stream(
            chat_id,
            {"type": "reconnect", "msg_id": msg_id, "last_seq": last_seq},
        )

    def chat_interrupt(
        self,
        chat_id: str,
        message: str,
        attached_docs: Optional[list] = None,
        orchestration: str = "auto",
    ) -> AsyncGenerator[ChatEvent, None]:
        """
        Cancel the current turn and start a new one seeded with a plan.
        """
        frame: dict = {
            "type": "chat_interrupt",
            "message": message,
            "orchestration": orchestration,
        }
        if attached_docs:
            frame["attached_docs"] = attached_docs
        return self._ws_stream(chat_id, frame)

    # -- SSE streaming (hosted service) ------------------------------

    @staticmethod
    def _dispatch_sse_event(data_lines: list[str]) -> Optional[ChatEvent]:
        """Map one assembled SSE event payload to a ChatEvent.

        The payload is the JSON object the backend writes on the ``data:``
        line: ``{"event": name, "data": {...}, "seq": n}``.
        """
        if not data_lines:
            return None
        payload = "\n".join(data_lines)
        try:
            frame = json.loads(payload)
        except json.JSONDecodeError:
            return None
        if not isinstance(frame, dict):
            return None
        event = frame.get("event", "")
        return _map_chat_event(
            event if isinstance(event, str) else "", frame.get("data", {})
        )

    async def _sse_stream(
        self, chat_id: str, request_body: dict, timeout: float
    ) -> AsyncGenerator[ChatEvent, None]:
        url = f"{self.base_url}/v1/chats/{quote(chat_id)}/stream"
        headers = {
            **self._headers,
            "Accept": "text/event-stream",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, read=timeout)
        ) as ac:
            async with ac.stream(
                "POST", url, json=request_body, headers=headers
            ) as resp:
                resp.raise_for_status()
                data_lines: list[str] = []
                async for line in resp.aiter_lines():
                    if line == "":
                        evt = self._dispatch_sse_event(data_lines)
                        data_lines = []
                        if evt is None:
                            continue
                        yield evt
                        if evt.type in ("done", "error"):
                            return
                        continue
                    if line.startswith(":") or not line.startswith("data:"):
                        continue
                    value = line[5:]
                    if value.startswith(" "):
                        value = value[1:]
                    data_lines.append(value)
                # Flush a final event that arrived without a blank line.
                evt = self._dispatch_sse_event(data_lines)
                if evt is not None:
                    yield evt

    async def chat_stream_sse(
        self,
        chat_id: str,
        message: str,
        *,
        model: Optional[str] = None,
        orchestration: Optional[str] = None,
        parent_msg_id: Optional[str] = None,
        retry_msg_id: Optional[str] = None,
        base_msg_id: Optional[str] = None,
        timeout: float = 600.0,
    ) -> AsyncGenerator[ChatEvent, None]:
        """
        Stream a chat turn over SSE (hosted service).

        Use this instead of :meth:`chat_stream` when a WebSocket upgrade is
        unavailable; events and terminal semantics are identical.

        Args:
            chat_id: Chat identifier.
            message: User message (empty for pure retries driven by ids).
            model: Optional model override forwarded to the backend.
            orchestration: "auto" (strategy-based) or "direct"; server
                default when omitted.
            parent_msg_id, retry_msg_id, base_msg_id: retry/edit context -
                call retry_chat_message() first for retries.
            timeout: Read timeout in seconds for the event stream.

        Yields:
            ChatEvent objects (thinking -> answer -> citation* -> done/error).
            Consume with ``async for``.
        """
        body: dict = {"type": "chat", "message": message}
        if model:
            body["model"] = model
        if orchestration:
            body["orchestration"] = orchestration
        if parent_msg_id:
            body["parent_msg_id"] = parent_msg_id
        if retry_msg_id:
            body["retry_msg_id"] = retry_msg_id
        if base_msg_id:
            body["base_msg_id"] = base_msg_id
        async for evt in self._sse_stream(chat_id, body, timeout):
            yield evt

    async def chat_reconnect_sse(
        self,
        chat_id: str,
        msg_id: str,
        last_seq: int = -1,
        *,
        timeout: float = 600.0,
    ) -> AsyncGenerator[ChatEvent, None]:
        """
        Replay missed events over SSE (hosted service).

        Mirrors :meth:`chat_reconnect` for deployments without WebSocket
        support.
        """
        body = {"type": "reconnect", "msg_id": msg_id, "last_seq": last_seq}
        async for evt in self._sse_stream(chat_id, body, timeout):
            yield evt

    # ════════════════════════════════════════════════════════════════════════
    # REASONING RAG QUERY
    # ════════════════════════════════════════════════════════════════════════

    def query(
        self,
        query_text: str,
        file_id: Optional[str] = None,
        file_ids: Optional[list[str]] = None,
        include_images: bool = False,
        inline_images: bool = False,
        session_id: Optional[str] = None,
        message_id: Optional[str] = None,
        root_collection: Optional[str] = None,
    ) -> QueryResponse:
        """
        Reasoning RAG query over indexed documents.

        Args:
            query_text: The query string.
            file_id: Single file ID to query.
            file_ids: Multiple file IDs to query.
            include_images: Include image URLs in response.
            inline_images: Inline base64 images in response.
            session_id: Session ID for conversation continuity.
            message_id: Message ID the answer attaches to (enables persistence).
            root_collection: Firestore root collection override.

        Returns:
            QueryResponse with answer, citations, and reasoning traces.
        """
        body: dict = {"query": query_text}
        if file_id:
            body["file_id"] = file_id
        if file_ids:
            body["file_ids"] = file_ids
        if include_images:
            body["includeImages"] = True
        if inline_images:
            body["inlineImages"] = True
        if session_id:
            body["sessionId"] = session_id
        if message_id:
            body["messageId"] = message_id
        if root_collection:
            body["rootCollection"] = root_collection

        resp = httpx.post(
            f"{self.base_url}/v1/query",
            json=body,
            headers=self._headers,
            timeout=300,
        )
        resp.raise_for_status()
        d = resp.json()
        return QueryResponse(
            answer=d.get("answer", ""),
            citations=[cited_node_from_dict(c) for c in d.get("citations", [])],
            reasoning_traces=d.get("reasoning_traces", []) or [],
            sub_questions=d.get("sub_questions", []) or [],
            nodes_retrieved=d.get("nodes_retrieved", 0) or 0,
            iterations=d.get("iterations", 0) or 0,
        )

    def cancel_query(
        self,
        session_id: str,
        message_id: str,
        root_collection: Optional[str] = None,
    ) -> dict:
        """
        Cancel an active reasoning query.
        """
        body: dict = {"session_id": session_id, "message_id": message_id}
        if root_collection:
            body["root_collection"] = root_collection
        resp = httpx.post(
            f"{self.base_url}/v1/query/cancel",
            json=body,
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    # ════════════════════════════════════════════════════════════════════════
    # CODEGEN
    # ════════════════════════════════════════════════════════════════════════

    def codegen_health(self) -> dict:
        """Codegen service health (no auth required)."""
        resp = httpx.get(f"{self.base_url}/v1/codegen/health", timeout=10)
        resp.raise_for_status()
        return resp.json()

    def generate_code(
        self,
        chat_id: str,
        file_id: str,
        task: str = "excel_index",
        prompt: Optional[str] = None,
        output_hint: Optional[str] = None,
        entity_context: Optional[str] = None,
        exhaustive: Optional[bool] = None,
        artifact_name: Optional[str] = None,
    ) -> CodegenResponse:
        """
        Generate (and for excel_index, execute) code for a document.
        """
        body: dict = {"chat_id": chat_id, "file_id": file_id, "task": task}
        if prompt is not None:
            body["prompt"] = prompt
        if output_hint is not None:
            body["output_hint"] = output_hint
        if entity_context is not None:
            body["entity_context"] = entity_context
        if exhaustive is not None:
            body["exhaustive"] = exhaustive
        if artifact_name is not None:
            body["artifact_name"] = artifact_name
        resp = httpx.post(
            f"{self.base_url}/v1/codegen/generate",
            json=body,
            headers=self._headers,
            timeout=300,
        )
        resp.raise_for_status()
        d = resp.json()
        return CodegenResponse(
            code_id=d.get("code_id", ""),
            code=d.get("code", ""),
            explanation=d.get("explanation", ""),
            run_id=d.get("run_id"),
            output=d.get("output") or {},
        )

    def list_codes(self, chat_id: str) -> dict:
        """List generated code artifacts for a chat."""
        resp = httpx.get(
            f"{self.base_url}/v1/codegen/{quote(chat_id)}/codes",
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    def get_code(
        self,
        chat_id: str,
        code_id: str,
        version: Optional[int] = None,
        latest: bool = False,
    ) -> dict:
        """Fetch a persisted code artifact."""
        params: dict = {}
        if version is not None:
            params["version"] = version
        if latest:
            params["latest"] = 1
        resp = httpx.get(
            f"{self.base_url}/v1/codegen/{quote(chat_id)}/code/{quote(code_id)}",
            params=params or None,
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    def put_code(
        self,
        chat_id: str,
        code_id: str,
        code: str,
        explanation: str = "",
        task: str = "",
        source: str = "",
        fork: bool = False,
        version: Optional[int] = None,
    ) -> dict:
        """Persist a modified code artifact (fork=True forks to a new id)."""
        params: dict = {}
        if fork:
            params["fork"] = 1
        if version is not None:
            params["version"] = version
        body: dict = {"code": code, "explanation": explanation, "task": task}
        if source:
            body["source"] = source
        resp = httpx.put(
            f"{self.base_url}/v1/codegen/{quote(chat_id)}/code/{quote(code_id)}",
            params=params or None,
            json=body,
            headers=self._headers,
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json()

    def predict(self, body: dict) -> dict:
        """Forward a tabular prediction request to the predictor service."""
        resp = httpx.post(
            f"{self.base_url}/v1/codegen/predict",
            json=body,
            headers=self._headers,
            timeout=600,
        )
        resp.raise_for_status()
        return resp.json()

    def get_artifact(self, chat_id: str, name: str) -> dict:
        """Download a persisted named artifact (JSON inline, .xlsx by reference)."""
        resp = httpx.get(
            f"{self.base_url}/v1/codegen/artifacts/{quote(chat_id)}/{quote(name)}",
            headers=self._headers,
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json()

    # ════════════════════════════════════════════════════════════════════════
    # TABLES / MODELS / SKILLS
    # ════════════════════════════════════════════════════════════════════════

    def synthesize_table(self, file_id: str, pages: list[int]) -> dict:
        """Synthesize a table from document pages."""
        resp = httpx.post(
            f"{self.base_url}/v1/tables/synthesize",
            json={"file_id": file_id, "pages": pages},
            headers=self._headers,
            timeout=300,
        )
        resp.raise_for_status()
        return resp.json()

    def get_toc(self, file_id: str) -> dict:
        """Document table of contents + sequential table groups."""
        resp = httpx.get(
            f"{self.base_url}/v1/tables/toc/{quote(file_id)}",
            headers=self._headers,
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json()

    def list_models(self) -> dict:
        """Public model provenance + per-section defaults."""
        resp = httpx.get(
            f"{self.base_url}/v1/models",
            headers=self._headers,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    def generate_skill(self, prompt: str) -> Skill:
        """Generate a custom skill from a description."""
        resp = httpx.post(
            f"{self.base_url}/v1/skills/generate",
            json={"prompt": prompt},
            headers=self._headers,
            timeout=120,
        )
        resp.raise_for_status()
        d = resp.json()
        return Skill(
            name=d.get("name", ""),
            description=d.get("description", ""),
            instruction=d.get("instruction", ""),
        )
