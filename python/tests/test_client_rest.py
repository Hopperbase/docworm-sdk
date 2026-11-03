"""Characterization tests for the REST half of docworm.client.

client.py calls the module-level httpx.get/post/put/patch/delete functions
directly (there is no injectable transport on DocWorm), so these tests
monkeypatch those functions to route every call through an
httpx.MockTransport. Real httpx Request/Response objects are still used, so
headers, multipart bodies, query strings, raise_for_status() and error types
are exactly what the SDK sees in production.
"""

import json

import httpx
import pytest

from docworm.client import DocWorm
from docworm.models import DocumentStatus, UploadResponse, UsageInfo


# ---------------------------------------------------------------------------
# transport helper
# ---------------------------------------------------------------------------


def mock_http(monkeypatch, responder):
    """Route module-level httpx verbs through a MockTransport.

    Returns the list of requests seen, in order.
    """
    recorded = []

    def handler(request):
        recorded.append(request)
        return responder(request)

    transport = httpx.MockTransport(handler)

    def send(method, url, **kwargs):
        with httpx.Client(transport=transport) as http_client:
            return http_client.request(method, url, **kwargs)

    monkeypatch.setattr(
        httpx, "request", lambda method, url, **kw: send(method, url, **kw)
    )
    for verb in ("get", "post", "put", "patch", "delete"):
        monkeypatch.setattr(
            httpx,
            verb,
            lambda url, _v=verb.upper(), **kw: send(_v, url, **kw),
        )
    return recorded


def json_response(payload, status_code=200):
    return httpx.Response(status_code, json=payload)


def assert_auth_only(request, key="test-key"):
    headers = {name.lower(): value for name, value in request.headers.items()}
    assert headers["authorization"] == f"Bearer {key}"
    credential_like = {
        "x-api-key",
        "api-key",
        "x-auth-token",
        "cookie",
        "proxy-authorization",
    }
    assert credential_like.isdisjoint(headers)


# ---------------------------------------------------------------------------
# verb + path
# ---------------------------------------------------------------------------


def test_upload_posts_multipart_to_v1_upload(monkeypatch, client):
    recorded = mock_http(
        monkeypatch,
        lambda request: json_response(
            {
                "status": "uploaded",
                "file_id": "file-1",
                "filename": "report.pdf",
                "gcs_raw_path": "gs://bucket/report.pdf",
            }
        ),
    )

    result = client.upload(b"%PDF-1.4 body", filename="report.pdf")

    request = recorded[0]
    assert request.method == "POST"
    assert request.url.path == "/v1/upload"
    assert request.headers["content-type"].startswith("multipart/form-data")
    assert b'name="file"; filename="report.pdf"' in request.content
    assert b"%PDF-1.4 body" in request.content
    assert isinstance(result, UploadResponse)
    assert (result.status, result.file_id, result.filename) == (
        "uploaded",
        "file-1",
        "report.pdf",
    )
    assert result.gcs_raw_path == "gs://bucket/report.pdf"


def test_index_sends_file_id_as_query_param(monkeypatch, client):
    recorded = mock_http(
        monkeypatch,
        lambda request: json_response(
            {
                "status": "queued",
                "file_id": "file-1",
                "filename": "report.pdf",
                "total_pages": 3,
            }
        ),
    )

    result = client.index("file-1")

    request = recorded[0]
    assert request.method == "POST"
    assert request.url.path == "/v1/index"
    assert request.url.params.get("file_id") == "file-1"
    # No optional scoping fields -> no form body and no content-type.
    headers = {name.lower(): value for name, value in request.headers.items()}
    assert "content-type" not in headers
    assert request.content == b""
    assert (result.status, result.file_id, result.filename) == (
        "queued",
        "file-1",
        "report.pdf",
    )
    assert result.total_pages == 3


def test_index_sends_scoping_fields_as_form_data(monkeypatch, client):
    recorded = mock_http(
        monkeypatch,
        lambda request: json_response(
            {
                "status": "queued",
                "file_id": "file-1",
                "filename": "report.pdf",
                "total_pages": 3,
            }
        ),
    )

    client.index("file-1", project_id="proj-1", chat_id="chat-1")

    request = recorded[0]
    assert request.method == "POST"
    assert request.url.path == "/v1/index"
    assert request.url.params.get("file_id") == "file-1"
    assert request.headers["content-type"].startswith(
        "application/x-www-form-urlencoded"
    )
    body = request.content.decode()
    assert "project_id=proj-1" in body
    assert "chat_id=chat-1" in body
    assert "file_id" not in body


def test_get_document_status_uses_get_and_parses_camel_case(monkeypatch, client):
    recorded = mock_http(
        monkeypatch,
        lambda request: json_response(
            {
                "fileId": "file-1",
                "status": "processing",
                "ready": False,
                "filename": "report.pdf",
                "totalPages": 10,
                "processedPages": 4,
                "progressPct": 40.0,
                "error": None,
                "createdAt": "2026-01-01T00:00:00Z",
                "completedAt": None,
                "treeVersion": "v3",
            }
        ),
    )

    status = client.get_document_status("file-1")

    request = recorded[0]
    assert request.method == "GET"
    assert request.url.path == "/v1/documents/file-1/status"
    assert isinstance(status, DocumentStatus)
    assert status.file_id == "file-1"
    assert status.status == "processing"
    assert status.ready is False
    assert (status.total_pages, status.processed_pages) == (10, 4)
    assert status.progress_pct == 40.0
    assert status.created_at == "2026-01-01T00:00:00Z"
    assert status.completed_at is None
    assert status.tree_version == "v3"


def test_create_chat_posts_to_v1_chats(monkeypatch, client):
    recorded = mock_http(
        monkeypatch,
        lambda request: json_response(
            {"id": "chat-1", "display_name": "Demo", "created_at": "2026-01-01"}
        ),
    )

    info = client.create_chat("chat-1", title="T", display_name="Demo", model="m")

    request = recorded[0]
    assert request.method == "POST"
    assert request.url.path == "/v1/chats"
    assert json.loads(request.content) == {
        "chatId": "chat-1",
        "title": "T",
        "display_name": "Demo",
        "model": "m",
    }
    assert info.id == "chat-1"
    assert info.chat_id == "chat-1"
    assert info.display_name == "Demo"
    assert info.created_at == "2026-01-01"


def test_list_chats_gets_v1_chats(monkeypatch, client):
    recorded = mock_http(
        monkeypatch,
        lambda request: json_response({"chats": [{"id": "chat-1"}]}),
    )

    chats = client.list_chats()

    assert recorded[0].method == "GET"
    assert recorded[0].url.path == "/v1/chats"
    assert chats == [{"id": "chat-1"}]


def test_register_chat_file_requires_file_id(monkeypatch, client):
    mock_http(
        monkeypatch,
        lambda request: json_response({"fileId": "file-1", "id": "chat-file-1"}),
    )

    with pytest.raises(TypeError):
        client.register_chat_file("report.pdf", "gs://bucket/report.pdf", "chat-1")


def test_register_chat_file_always_sends_file_id(monkeypatch, client):
    recorded = mock_http(
        monkeypatch,
        lambda request: json_response({"fileId": "file-1", "id": "chat-file-1"}),
    )

    result = client.register_chat_file(
        "report.pdf", "gs://bucket/report.pdf", "chat-1", "file-1"
    )

    request = recorded[0]
    assert request.method == "POST"
    assert request.url.path == "/v1/chat-files"
    body = json.loads(request.content)
    assert body["fileId"] == "file-1"
    assert (body["name"], body["gcsPath"], body["chatId"]) == (
        "report.pdf",
        "gs://bucket/report.pdf",
        "chat-1",
    )
    assert result == {"fileId": "file-1", "id": "chat-file-1"}


def test_attach_documents_posts_file_ids(monkeypatch, client):
    recorded = mock_http(
        monkeypatch,
        lambda request: json_response({"chat_id": "chat-1", "attachments": []}),
    )

    result = client.attach_documents("chat-1", ["file-1", "file-2"])

    request = recorded[0]
    assert request.method == "POST"
    assert request.url.path == "/v1/chats/chat-1/attach"
    assert json.loads(request.content) == {"file_ids": ["file-1", "file-2"]}
    assert result == {"chat_id": "chat-1", "attachments": []}


def test_get_messages_sends_query_params(monkeypatch, client):
    recorded = mock_http(
        monkeypatch,
        lambda request: json_response(
            {
                "messages": [
                    {
                        "msg_id": "msg-1",
                        "role": "assistant",
                        "content": "hello",
                        "usage": {
                            "prompt_tokens": 2,
                            "completion_tokens": 3,
                            "total_tokens": 5,
                        },
                        "citations": [{"node_id": "n1", "fileId": "file-1"}],
                    }
                ],
                "has_more": True,
            }
        ),
    )

    result = client.get_messages(
        "chat-1",
        limit=25,
        parent_limit=5,
        before="2026-01-01",
        before_id="msg-0",
    )

    request = recorded[0]
    assert request.method == "GET"
    assert request.url.path == "/v1/chats/chat-1/messages"
    assert request.url.params.get("limit") == "25"
    assert request.url.params.get("parent_limit") == "5"
    assert request.url.params.get("before") == "2026-01-01"
    assert request.url.params.get("before_id") == "msg-0"

    assert result["has_more"] is True
    message = result["messages"][0]
    assert message.msg_id == "msg-1"
    assert message.content == "hello"
    assert message.usage.prompt_tokens == 2
    assert message.citations[0].node_id == "n1"
    assert message.citations[0].file_id == "file-1"


def test_delete_file_uses_delete_on_v1_files(monkeypatch, client):
    recorded = mock_http(
        monkeypatch, lambda request: json_response({"status": "deleted"})
    )

    result = client.delete_file("file-1")

    assert recorded[0].method == "DELETE"
    assert recorded[0].url.path == "/v1/files/file-1"
    assert result == {"status": "deleted"}


def test_query_posts_body_fields_and_parses_response(monkeypatch, client):
    recorded = mock_http(
        monkeypatch,
        lambda request: json_response(
            {
                "answer": "the answer",
                "citations": [
                    {
                        "node_id": "n1",
                        "title": "Section",
                        "start_page": 2,
                        "end_page": 3,
                        "filename": "report.pdf",
                        "fileId": "file-1",
                    }
                ],
                "reasoning_traces": ["step one"],
                "sub_questions": ["which?"],
                "nodes_retrieved": 4,
                "iterations": 2,
            }
        ),
    )

    result = client.query(
        "what is it?",
        file_id="file-1",
        file_ids=["file-1", "file-2"],
        include_images=True,
        inline_images=True,
        session_id="sess-1",
        message_id="msg-1",
        root_collection="root",
    )

    request = recorded[0]
    assert request.method == "POST"
    assert request.url.path == "/v1/query"
    assert json.loads(request.content) == {
        "query": "what is it?",
        "file_id": "file-1",
        "file_ids": ["file-1", "file-2"],
        "includeImages": True,
        "inlineImages": True,
        "sessionId": "sess-1",
        "messageId": "msg-1",
        "rootCollection": "root",
    }
    assert result.answer == "the answer"
    assert result.citations[0].file_id == "file-1"
    assert result.reasoning_traces == ["step one"]
    assert result.sub_questions == ["which?"]
    assert result.nodes_retrieved == 4
    assert result.iterations == 2


# ---------------------------------------------------------------------------
# auth
# ---------------------------------------------------------------------------


def test_every_request_carries_only_the_bearer_header(monkeypatch, client):
    recorded = mock_http(
        monkeypatch,
        lambda request: json_response(
            {
                "file_id": "file-1",
                "status": "processing",
                "ready": False,
                "chats": [],
                "documents": [],
            }
        ),
    )

    client.list_documents()
    client.get_document_status("file-1")
    client.list_chats()
    client.upload(b"body", filename="report.pdf")
    client.delete_file("file-1")

    assert len(recorded) == 5
    for request in recorded:
        assert_auth_only(request)


def test_api_key_client_sends_x_api_key_and_no_bearer(monkeypatch):
    recorded = mock_http(
        monkeypatch,
        lambda request: json_response({"documents": [], "chats": []}),
    )
    api_key_client = DocWorm(
        api_key="dw_live_test", base_url="https://api.example.test"
    )

    api_key_client.list_documents()
    api_key_client.list_chats()

    assert len(recorded) == 2
    for request in recorded:
        headers = {name.lower(): value for name, value in request.headers.items()}
        assert headers["x-api-key"] == "dw_live_test"
        assert "authorization" not in headers


def test_plain_token_client_sends_bearer_and_no_x_api_key(monkeypatch):
    recorded = mock_http(
        monkeypatch,
        lambda request: json_response({"documents": [], "chats": []}),
    )
    token_client = DocWorm(
        api_key="firebase-token", base_url="https://api.example.test"
    )

    token_client.list_documents()
    token_client.list_chats()

    assert len(recorded) == 2
    for request in recorded:
        headers = {name.lower(): value for name, value in request.headers.items()}
        assert headers["authorization"] == "Bearer firebase-token"
        assert "x-api-key" not in headers


# ---------------------------------------------------------------------------
# error handling
# ---------------------------------------------------------------------------


def test_4xx_response_raises_httpx_http_status_error(monkeypatch, client):
    mock_http(
        monkeypatch,
        lambda request: httpx.Response(403, text="forbidden"),
    )

    with pytest.raises(httpx.HTTPStatusError) as excinfo:
        client.get_document_status("file-1")

    assert excinfo.value.response.status_code == 403


# ---------------------------------------------------------------------------
# wait_for_indexing
# ---------------------------------------------------------------------------


def _status_responder(statuses):
    calls = {"n": 0}

    def responder(request):
        index = min(calls["n"], len(statuses) - 1)
        calls["n"] += 1
        return json_response(statuses[index])

    return responder


@pytest.mark.parametrize(
    "status",
    [
        {"fileId": "file-1", "status": "processing", "ready": True},
        {"fileId": "file-1", "status": "ready", "ready": False},
        {"fileId": "file-1", "status": "completed", "ready": False},
        {"fileId": "file-1", "status": "indexed", "ready": False},
    ],
)
def test_wait_for_indexing_returns_on_terminal_success(
    monkeypatch, client, status
):
    recorded = mock_http(monkeypatch, _status_responder([status]))

    result = client.wait_for_indexing("file-1", timeout=5, poll_interval=0)

    assert result.file_id == "file-1"
    assert result.status == status["status"]
    assert len(recorded) == 1


def test_wait_for_indexing_polls_until_ready(monkeypatch, client):
    recorded = mock_http(
        monkeypatch,
        _status_responder(
            [
                {"fileId": "file-1", "status": "processing", "ready": False},
                {"fileId": "file-1", "status": "processing", "ready": False},
                {"fileId": "file-1", "status": "ready", "ready": True},
            ]
        ),
    )

    result = client.wait_for_indexing("file-1", timeout=5, poll_interval=0)

    assert result.ready is True
    assert len(recorded) == 3


@pytest.mark.parametrize("status", ["error", "failed", "cancelled"])
def test_wait_for_indexing_raises_runtime_error_on_failure(
    monkeypatch, client, status
):
    mock_http(
        monkeypatch,
        _status_responder(
            [{"fileId": "file-1", "status": status, "error": "boom"}]
        ),
    )

    with pytest.raises(RuntimeError) as excinfo:
        client.wait_for_indexing("file-1", timeout=5, poll_interval=0)

    assert str(excinfo.value) == f"Indexing {status}: boom"


def test_wait_for_indexing_raises_timeout_error(monkeypatch, client):
    recorded = mock_http(
        monkeypatch,
        _status_responder(
            [{"fileId": "file-1", "status": "processing", "ready": False}]
        ),
    )

    with pytest.raises(TimeoutError):
        client.wait_for_indexing("file-1", timeout=-1, poll_interval=0)

    assert recorded == []


# ---------------------------------------------------------------------------
# usage token field names
# ---------------------------------------------------------------------------


def test_usage_maps_backend_and_legacy_keys():
    backend = DocWorm._map_ws_event(
        "done",
        {
            "msg_id": "msg-1",
            "usage": {
                "input_tokens": 11,
                "output_tokens": 7,
                "calls": 3,
                "thinking_tokens": 5,
            },
        },
    )

    assert backend.type == "done"
    assert backend.usage == UsageInfo(
        prompt_tokens=11,
        completion_tokens=7,
        total_tokens=18,
        calls=3,
        thinking_tokens=5,
    )

    legacy = DocWorm._map_ws_event(
        "done",
        {
            "msg_id": "msg-1",
            "usage": {
                "prompt_tokens": 2,
                "completion_tokens": 3,
                "total_tokens": 99,
            },
        },
    )

    assert legacy.usage is not None
    assert legacy.usage.prompt_tokens == 2
    assert legacy.usage.completion_tokens == 3
    assert legacy.usage.total_tokens == 99
    assert legacy.usage.calls == 0
    assert legacy.usage.thinking_tokens == 0

    for empty in ({}, None):
        event = DocWorm._map_ws_event(
            "done", {"msg_id": "msg-1", "usage": empty}
        )
        assert event.usage == UsageInfo()


def test_usage_parser_reads_prompt_and_completion_keys():
    event = DocWorm._map_ws_event(
        "done",
        {
            "msg_id": "msg-1",
            "usage": {
                "prompt_tokens": 11,
                "completion_tokens": 7,
                "total_tokens": 18,
            },
        },
    )

    assert event.usage is not None
    assert event.usage.prompt_tokens == 11
    assert event.usage.completion_tokens == 7
    assert event.usage.total_tokens == 18
