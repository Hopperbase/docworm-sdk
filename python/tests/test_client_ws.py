"""Characterization tests for docworm.client WebSocket chat streaming.

client.py imports `websockets` inside _ws_stream and calls
websockets.connect(url, max_size=...) as an async context manager. These
tests replace websockets.connect with a scripted fake socket: it records the
frames the SDK sends and replays the frames the backend would send.
"""

import json

import pytest
import websockets

from docworm.client import DocWorm

pytestmark = pytest.mark.asyncio

AUTH_OK = json.dumps({"type": "auth_ok"})


class FakeWebSocket:
    def __init__(self, incoming):
        # First item is consumed by the explicit auth recv(); the rest are
        # delivered through the async iterator.
        self.incoming = list(incoming)
        self.sent = []
        self.closed = False

    async def send(self, payload):
        self.sent.append(json.loads(payload))

    async def recv(self):
        return self.incoming.pop(0)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self.incoming:
            raise StopAsyncIteration
        return self.incoming.pop(0)

    async def close(self):
        self.closed = True


class FakeConnect:
    def __init__(self, ws, url, kwargs):
        self.ws = ws
        self.url = url
        self.kwargs = kwargs

    async def __aenter__(self):
        return self.ws

    async def __aexit__(self, exc_type, exc, tb):
        self.ws.closed = True
        return False


def install_ws(monkeypatch, incoming, auth_response=AUTH_OK):
    ws = FakeWebSocket([auth_response] + list(incoming))
    connections = []

    def fake_connect(url, **kwargs):
        connection = FakeConnect(ws, url, kwargs)
        connections.append(connection)
        return connection

    monkeypatch.setattr(websockets, "connect", fake_connect)
    return ws, connections


def frame(event, data):
    return json.dumps({"event": event, "data": data})


async def collect(stream):
    return [event async for event in stream]


# ---------------------------------------------------------------------------
# auth handshake
# ---------------------------------------------------------------------------


async def test_auth_frame_uses_token_for_plain_keys(monkeypatch):
    ws, connections = install_ws(monkeypatch, [frame("done", {})])
    client = DocWorm(api_key="firebase-token", base_url="https://api.example.test")

    await collect(client.chat_stream("chat-1", "hello"))

    assert ws.sent[0] == {"type": "auth", "token": "firebase-token"}
    assert connections[0].url == "wss://api.example.test/v1/chats/chat-1/chat"
    assert connections[0].kwargs == {"max_size": 16 * 1024 * 1024}


async def test_auth_frame_uses_api_key_for_dw_live_keys(monkeypatch):
    ws, _ = install_ws(monkeypatch, [frame("done", {})])
    client = DocWorm(
        api_key="dw_live_abc123", base_url="https://api.example.test"
    )

    await collect(client.chat_stream("chat-1", "hello"))

    assert ws.sent[0] == {"type": "auth", "api_key": "dw_live_abc123"}
    assert "token" not in ws.sent[0]


async def test_auth_error_becomes_error_event_and_stops(monkeypatch):
    ws, _ = install_ws(
        monkeypatch,
        [],
        auth_response=json.dumps({"type": "error", "error": "bad key"}),
    )
    client = DocWorm(api_key="test-key", base_url="https://api.example.test")

    events = await collect(client.chat_stream("chat-1", "hello"))

    assert [event.type for event in events] == ["error"]
    assert events[0].error == "bad key"
    # Only the auth frame was written; the chat frame never went out.
    assert ws.sent == [{"type": "auth", "token": "test-key"}]


async def test_auth_invalid_json_becomes_error_event(monkeypatch):
    ws, _ = install_ws(monkeypatch, [], auth_response="not json")
    client = DocWorm(api_key="test-key", base_url="https://api.example.test")

    events = await collect(client.chat_stream("chat-1", "hello"))

    assert [event.type for event in events] == ["error"]
    assert events[0].error == "WS auth: invalid response"
    assert len(ws.sent) == 1


async def test_auth_ok_stringifies_non_string_error(monkeypatch):
    _, _unused = install_ws(
        monkeypatch,
        [],
        auth_response=json.dumps({"type": "nope", "error": {"code": 7}}),
    )
    client = DocWorm(api_key="test-key", base_url="https://api.example.test")

    events = await collect(client.chat_stream("chat-1", "hello"))

    assert [event.type for event in events] == ["error"]
    assert events[0].error == "{'code': 7}"


# ---------------------------------------------------------------------------
# outgoing request frames
# ---------------------------------------------------------------------------


async def test_chat_frame_omits_empty_optional_fields(monkeypatch):
    ws, _ = install_ws(monkeypatch, [frame("done", {})])
    client = DocWorm(api_key="test-key", base_url="https://api.example.test")

    await collect(client.chat_stream("chat-1", "hello"))

    assert ws.sent[1] == {
        "type": "chat",
        "message": "hello",
        "orchestration": "auto",
    }


async def test_chat_frame_includes_retry_context_when_given(monkeypatch):
    ws, _ = install_ws(monkeypatch, [frame("done", {})])
    client = DocWorm(api_key="test-key", base_url="https://api.example.test")

    await collect(
        client.chat_stream(
            "chat-1",
            "",
            attached_docs=[{"id": "file-1", "name": "report.pdf"}],
            orchestration="direct",
            parent_msg_id="parent-1",
            retry_msg_id="retry-1",
            base_msg_id="base-1",
        )
    )

    assert ws.sent[1] == {
        "type": "chat",
        "message": "",
        "orchestration": "direct",
        "attached_docs": [{"id": "file-1", "name": "report.pdf"}],
        "parent_msg_id": "parent-1",
        "retry_msg_id": "retry-1",
        "base_msg_id": "base-1",
    }


async def test_reconnect_frame_defaults_to_last_seq_minus_one(monkeypatch):
    ws, _ = install_ws(monkeypatch, [frame("done", {})])
    client = DocWorm(api_key="test-key", base_url="https://api.example.test")

    await collect(client.chat_reconnect("chat-1", "msg-1"))

    assert ws.sent[1] == {
        "type": "reconnect",
        "msg_id": "msg-1",
        "last_seq": -1,
    }


async def test_reconnect_frame_accepts_explicit_last_seq(monkeypatch):
    ws, _ = install_ws(monkeypatch, [frame("done", {})])
    client = DocWorm(api_key="test-key", base_url="https://api.example.test")

    await collect(client.chat_reconnect("chat-1", "msg-1", last_seq=42))

    assert ws.sent[1] == {
        "type": "reconnect",
        "msg_id": "msg-1",
        "last_seq": 42,
    }


async def test_interrupt_frame_uses_chat_interrupt_type(monkeypatch):
    ws, _ = install_ws(monkeypatch, [frame("done", {})])
    client = DocWorm(api_key="test-key", base_url="https://api.example.test")

    await collect(client.chat_interrupt("chat-1", "stop this"))

    assert ws.sent[1] == {
        "type": "chat_interrupt",
        "message": "stop this",
        "orchestration": "auto",
    }


# ---------------------------------------------------------------------------
# event mapping
# ---------------------------------------------------------------------------


async def test_event_mapping_and_done_terminates(monkeypatch):
    ws, _ = install_ws(
        monkeypatch,
        [
            frame("thinking_chunk", {"text": "thinking chunk"}),
            frame("thought", {"text": "a thought"}),
            frame("status_chunk", {"text": "working"}),
            frame("answer_chunk", {"text": "the answer"}),
            frame(
                "citation",
                {
                    "citation": {
                        "node_id": "node-1",
                        "title": "Section",
                        "start_page": 2,
                        "end_page": 3,
                        "filename": "report.pdf",
                        "fileId": "file-1",
                    }
                },
            ),
            frame("action_start", {"text": "start", "name": "search"}),
            frame("action_complete", {"text": "done", "name": "search"}),
            frame("trace_item", {"text": "trace item"}),
            frame("plan_update", {"steps": ["a", "b"]}),
            frame("todo_updated", {"items": ["x"]}),
            frame(
                "done",
                {
                    "msg_id": "msg-1",
                    "usage": {
                        "prompt_tokens": 4,
                        "completion_tokens": 6,
                        "total_tokens": 10,
                    },
                },
            ),
            # Would be yielded if the iterator kept going after done.
            frame("answer_chunk", {"text": "too late"}),
        ],
    )
    client = DocWorm(api_key="test-key", base_url="https://api.example.test")

    events = await collect(client.chat_stream("chat-1", "hello"))

    assert [event.type for event in events] == [
        "thinking",
        "thinking",
        "status",
        "answer",
        "citation",
        "action",
        "action",
        "trace",
        "plan",
        "todo",
        "done",
    ]
    assert [event.text for event in events[:8]] == [
        "thinking chunk",
        "a thought",
        "working",
        "the answer",
        "",
        "start",
        "done",
        "trace item",
    ]
    citation = events[4].citation
    assert citation is not None
    assert citation.node_id == "node-1"
    assert citation.file_id == "file-1"
    assert citation.start_page == 2
    assert citation.end_page == 3
    assert events[5].data["name"] == "search"
    assert events[8].data == {"steps": ["a", "b"]}
    assert events[9].data == {"items": ["x"]}
    done = events[-1]
    assert done.msg_id == "msg-1"
    assert done.usage is not None
    assert (done.usage.prompt_tokens, done.usage.completion_tokens) == (4, 6)
    assert done.usage.total_tokens == 10
    assert ws.closed is True


async def test_error_event_stringifies_and_stops(monkeypatch):
    ws, _ = install_ws(
        monkeypatch,
        [
            frame("error", {"error": {"code": "quota", "detail": "x"}}),
            frame("answer_chunk", {"text": "unreachable"}),
        ],
    )
    client = DocWorm(api_key="test-key", base_url="https://api.example.test")

    events = await collect(client.chat_stream("chat-1", "hello"))

    assert [event.type for event in events] == ["error"]
    assert events[0].error == "{'code': 'quota', 'detail': 'x'}"


async def test_data_sent_as_json_string_is_normalized(monkeypatch):
    ws, _ = install_ws(
        monkeypatch,
        [
            json.dumps(
                {
                    "event": "answer_chunk",
                    "data": json.dumps({"text": "string data"}),
                }
            ),
            frame("done", {"msg_id": "msg-1"}),
        ],
    )
    client = DocWorm(api_key="test-key", base_url="https://api.example.test")

    events = await collect(client.chat_stream("chat-1", "hello"))

    assert [event.type for event in events] == ["answer", "done"]
    assert events[0].text == "string data"
    assert events[0].data == {"text": "string data"}


async def test_malformed_json_string_data_becomes_empty_dict(monkeypatch):
    install_ws(
        monkeypatch,
        [
            json.dumps({"event": "answer_chunk", "data": "{not json"}),
            "",
            frame("done", {"msg_id": "msg-1"}),
        ],
    )
    client = DocWorm(api_key="test-key", base_url="https://api.example.test")

    events = await collect(client.chat_stream("chat-1", "hello"))

    assert [event.type for event in events] == ["answer", "done"]
    assert events[0].text == ""
    assert events[0].data == {}


async def test_unmapped_event_is_skipped_without_ending_iteration(monkeypatch):
    install_ws(
        monkeypatch,
        [
            frame("plan_declared", {"plan": ["a"]}),
            frame("answer_chunk", {"text": "still streaming"}),
            frame("ping", {}),
            frame("done", {"msg_id": "msg-1"}),
        ],
    )
    client = DocWorm(api_key="test-key", base_url="https://api.example.test")

    events = await collect(client.chat_stream("chat-1", "hello"))

    assert [event.type for event in events] == ["answer", "done"]
    assert events[0].text == "still streaming"
