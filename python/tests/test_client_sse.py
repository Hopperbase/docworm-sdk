"""Characterization tests for the SSE chat stream in docworm.client.

client.py builds an ``httpx.AsyncClient`` and calls ``.stream("POST", ...)``
as an async context manager, so these tests replace ``httpx.AsyncClient``
with a scripted fake: it records the request and replays SSE lines the way a
backend would.

The SSE frame payload is the same JSON object the WebSocket path carries:
``{"event": name, "data": {...}, "seq": n}``.
"""

import json

import httpx
import pytest

from docworm.client import DocWorm

pytestmark = pytest.mark.asyncio


class FakeResponse:
    def __init__(self, lines, status_code=200, url="https://api.example.test"):
        self.lines = list(lines)
        self.status_code = status_code
        self._response = httpx.Response(
            status_code, request=httpx.Request("POST", url)
        )

    def raise_for_status(self):
        self._response.raise_for_status()

    async def aiter_lines(self):
        for line in self.lines:
            yield line


class FakeStream:
    def __init__(self, response):
        self.response = response

    async def __aenter__(self):
        return self.response

    async def __aexit__(self, exc_type, exc, tb):
        return False


def install_sse(monkeypatch, lines, status_code=200):
    """Replace httpx.AsyncClient with a fake replaying ``lines``."""
    response = FakeResponse(lines, status_code)
    clients = []

    class FakeAsyncClient:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.requests = []
            clients.append(self)

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def stream(self, method, url, **kwargs):
            self.requests.append({"method": method, "url": url, **kwargs})
            return FakeStream(response)

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)
    return response, clients


def sse(event, data, seq=0):
    return "data: " + json.dumps({"event": event, "data": data, "seq": seq})


def stream_lines(*frames):
    """Blank-line-separated events, ending with the final blank line."""
    lines = []
    for frame in frames:
        lines.extend([frame, ""])
    return lines


def request_of(clients):
    assert len(clients) == 1
    assert len(clients[0].requests) == 1
    return clients[0].requests[0]


async def collect(stream):
    return [event async for event in stream]


# ---------------------------------------------------------------------------
# request line, headers and auth
# ---------------------------------------------------------------------------


async def test_request_line_and_headers(monkeypatch):
    _, clients = install_sse(
        monkeypatch, stream_lines(sse("done", {"msg_id": "msg-1"}))
    )
    client = DocWorm(api_key="firebase-token", base_url="https://api.example.test")

    await collect(client.chat_stream_sse("chat-1", "hello"))

    request = request_of(clients)
    assert request["method"] == "POST"
    assert request["url"] == "https://api.example.test/v1/chats/chat-1/stream"
    assert request["headers"]["Authorization"] == "Bearer firebase-token"
    assert request["headers"]["Accept"] == "text/event-stream"
    assert request["headers"]["Content-Type"] == "application/json"
    assert "X-API-KEY" not in request["headers"]
    assert isinstance(clients[0].kwargs["timeout"], httpx.Timeout)


async def test_dw_live_key_uses_x_api_key_and_no_authorization(monkeypatch):
    _, clients = install_sse(
        monkeypatch, stream_lines(sse("done", {"msg_id": "msg-1"}))
    )
    client = DocWorm(api_key="dw_live_abc123", base_url="https://api.example.test")

    await collect(client.chat_stream_sse("chat-1", "hello"))

    headers = request_of(clients)["headers"]
    assert headers["X-API-KEY"] == "dw_live_abc123"
    assert "Authorization" not in headers


async def test_chat_body_omits_unset_optional_fields(monkeypatch):
    _, clients = install_sse(
        monkeypatch, stream_lines(sse("done", {"msg_id": "msg-1"}))
    )
    client = DocWorm(api_key="test-key", base_url="https://api.example.test")

    await collect(client.chat_stream_sse("chat-1", "hello"))

    assert request_of(clients)["json"] == {"type": "chat", "message": "hello"}


async def test_chat_body_includes_provided_optional_fields(monkeypatch):
    _, clients = install_sse(
        monkeypatch, stream_lines(sse("done", {"msg_id": "msg-1"}))
    )
    client = DocWorm(api_key="test-key", base_url="https://api.example.test")

    await collect(
        client.chat_stream_sse(
            "chat-1",
            "",
            model="gpt-test",
            orchestration="direct",
            parent_msg_id="parent-1",
            retry_msg_id="retry-1",
            base_msg_id="base-1",
        )
    )

    assert request_of(clients)["json"] == {
        "type": "chat",
        "message": "",
        "model": "gpt-test",
        "orchestration": "direct",
        "parent_msg_id": "parent-1",
        "retry_msg_id": "retry-1",
        "base_msg_id": "base-1",
    }


async def test_reconnect_body_defaults_to_last_seq_minus_one(monkeypatch):
    _, clients = install_sse(
        monkeypatch, stream_lines(sse("done", {"msg_id": "msg-1"}))
    )
    client = DocWorm(api_key="test-key", base_url="https://api.example.test")

    await collect(client.chat_reconnect_sse("chat-1", "msg-1"))

    assert request_of(clients)["json"] == {
        "type": "reconnect",
        "msg_id": "msg-1",
        "last_seq": -1,
    }


async def test_reconnect_body_accepts_explicit_last_seq(monkeypatch):
    _, clients = install_sse(
        monkeypatch, stream_lines(sse("done", {"msg_id": "msg-1"}))
    )
    client = DocWorm(api_key="test-key", base_url="https://api.example.test")

    await collect(client.chat_reconnect_sse("chat-1", "msg-1", last_seq=42))

    assert request_of(clients)["json"] == {
        "type": "reconnect",
        "msg_id": "msg-1",
        "last_seq": 42,
    }


# ---------------------------------------------------------------------------
# event parsing and mapping
# ---------------------------------------------------------------------------


async def test_answer_chunk_maps_to_chat_event(monkeypatch):
    install_sse(
        monkeypatch,
        stream_lines(
            sse("answer_chunk", {"text": "the answer"}),
            sse("done", {"msg_id": "msg-1"}),
        ),
    )
    client = DocWorm(api_key="test-key", base_url="https://api.example.test")

    events = await collect(client.chat_stream_sse("chat-1", "hello"))

    assert [event.type for event in events] == ["answer", "done"]
    assert events[0].text == "the answer"
    assert events[0].data == {"text": "the answer"}
    assert events[1].msg_id == "msg-1"


async def test_done_terminates_iteration(monkeypatch):
    install_sse(
        monkeypatch,
        stream_lines(
            sse("thinking_chunk", {"text": "thinking"}),
            sse("done", {"msg_id": "msg-1"}),
            sse("answer_chunk", {"text": "too late"}),
        ),
    )
    client = DocWorm(api_key="test-key", base_url="https://api.example.test")

    events = await collect(client.chat_stream_sse("chat-1", "hello"))

    assert [event.type for event in events] == ["thinking", "done"]
    assert events[0].text == "thinking"


async def test_error_event_terminates_iteration(monkeypatch):
    install_sse(
        monkeypatch,
        stream_lines(
            sse("error", {"error": {"code": "quota"}}),
            sse("answer_chunk", {"text": "unreachable"}),
        ),
    )
    client = DocWorm(api_key="test-key", base_url="https://api.example.test")

    events = await collect(client.chat_stream_sse("chat-1", "hello"))

    assert [event.type for event in events] == ["error"]
    assert events[0].error == "{'code': 'quota'}"


async def test_unmapped_event_is_skipped_without_ending_iteration(monkeypatch):
    install_sse(
        monkeypatch,
        stream_lines(
            sse("ping", {}),
            sse("answer_chunk", {"text": "still streaming"}),
            sse("status_heartbeat", {}),
            sse("done", {"msg_id": "msg-1"}),
        ),
    )
    client = DocWorm(api_key="test-key", base_url="https://api.example.test")

    events = await collect(client.chat_stream_sse("chat-1", "hello"))

    assert [event.type for event in events] == ["answer", "done"]
    assert events[0].text == "still streaming"


async def test_blank_line_separated_events_and_trailing_event_without_blank_line(
    monkeypatch,
):
    install_sse(
        monkeypatch,
        [
            sse("answer_chunk", {"text": "first"}),
            "",
            # Final event arrives with no trailing blank line.
            sse("done", {"msg_id": "msg-1"}),
        ],
    )
    client = DocWorm(api_key="test-key", base_url="https://api.example.test")

    events = await collect(client.chat_stream_sse("chat-1", "hello"))

    assert [event.type for event in events] == ["answer", "done"]
    assert events[0].text == "first"


async def test_multi_line_data_is_joined_with_newline(monkeypatch):
    frame = json.dumps(
        {"event": "answer_chunk", "data": {"text": "joined"}, "seq": 3},
        indent=0,
    )
    data_lines = [f"data: {part}" for part in frame.split("\n")]
    install_sse(
        monkeypatch,
        data_lines
        + [
            "",
            sse("done", {"msg_id": "msg-1"}),
            "",
        ],
    )
    client = DocWorm(api_key="test-key", base_url="https://api.example.test")

    events = await collect(client.chat_stream_sse("chat-1", "hello"))

    assert [event.type for event in events] == ["answer", "done"]
    assert events[0].text == "joined"


async def test_comments_and_non_data_lines_are_ignored(monkeypatch):
    install_sse(
        monkeypatch,
        [
            ": keep-alive comment",
            "event: message",
            "id: 7",
            sse("answer_chunk", {"text": "after noise"}),
            "",
            sse("done", {"msg_id": "msg-1"}),
            "",
        ],
    )
    client = DocWorm(api_key="test-key", base_url="https://api.example.test")

    events = await collect(client.chat_stream_sse("chat-1", "hello"))

    assert [event.type for event in events] == ["answer", "done"]
    assert events[0].text == "after noise"


async def test_json_string_data_is_normalized(monkeypatch):
    install_sse(
        monkeypatch,
        stream_lines(
            "data: "
            + json.dumps(
                {
                    "event": "answer_chunk",
                    "data": json.dumps({"text": "string data"}),
                }
            ),
            sse("done", {"msg_id": "msg-1"}),
        ),
    )
    client = DocWorm(api_key="test-key", base_url="https://api.example.test")

    events = await collect(client.chat_stream_sse("chat-1", "hello"))

    assert [event.type for event in events] == ["answer", "done"]
    assert events[0].text == "string data"
    assert events[0].data == {"text": "string data"}


# ---------------------------------------------------------------------------
# HTTP errors
# ---------------------------------------------------------------------------


async def test_http_error_status_raises(monkeypatch):
    install_sse(monkeypatch, [], status_code=404)
    client = DocWorm(api_key="test-key", base_url="https://api.example.test")

    with pytest.raises(httpx.HTTPStatusError) as exc_info:
        await collect(client.chat_stream_sse("chat-1", "hello"))

    assert exc_info.value.response.status_code == 404
