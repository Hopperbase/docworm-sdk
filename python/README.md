# DocWorm Python SDK

Python SDK for the DocWorm service — document indexing, knowledge graphs, reasoning RAG, and chat.

Full documentation: see the [`docs/`](../docs/) folder (Mintlify-powered).

## Installation

```bash
pip install docworm
```

Requires `httpx` and `websockets` (installed automatically).

## Quick Start

```python
import asyncio
from docworm import DocWorm

client = DocWorm(api_key="dw_live_...")  # or export DOCWORM_API_KEY

# Upload and index a document
upload = client.upload("report.pdf")
client.index(upload.file_id)
status = client.wait_for_indexing(upload.file_id)
print(f"Indexed {status.processed_pages}/{status.total_pages} pages")

# Create a chat and attach documents
client.create_chat("my-chat", display_name="My Chat")
client.attach_documents("my-chat", [upload.file_id])

# Stream a chat turn over SSE
async def main():
    async for event in client.chat_stream_sse("my-chat", "What does the report say?"):
        if event.type == "answer":
            print(event.text, end="")
        elif event.type == "citation":
            c = event.citation
            print(f"\n  [{c.filename}] p.{c.start_page}-{c.end_page}")
        elif event.type == "done":
            print(f"\nTokens: {event.usage.total_tokens}")

asyncio.run(main())
```

## Configuration

```python
client = DocWorm()  # reads DOCWORM_API_KEY, DOCWORM_URL, and config.yaml
client = DocWorm(api_key="dw_live_...")
```

Authenticate with a DocWorm API key (`dw_live_...`, sent via `X-API-KEY`). Copy
`config.yaml.example` to `config.yaml` for local file configuration.

Models resolve server-side from `model_configs/active` by default; use
`client.list_models()` to inspect the active defaults. Optional `model`
overrides are supported on chat creation and `chat_stream_sse`.

## Documents

### Upload

```python
# From file path
upload = client.upload("report.pdf")
print(upload.file_id)

# From bytes
upload = client.upload(b"<raw pdf bytes>", filename="report.pdf")

# From file object
with open("report.pdf", "rb") as f:
    upload = client.upload(f, filename="report.pdf")

# With custom file_id and scoping
upload = client.upload("report.pdf", file_id="my-custom-id", project_id="proj_1")
```

### Index

```python
# Index an uploaded document (usually status="queued")
resp = client.index(upload.file_id)

# Upload + index in one call (pass file to index)
resp = client.index("doc-123", file="report.pdf")

# Upload + index convenience wrapper (returns the queued IndexResponse)
resp = client.upload_and_index("report.pdf")

# Index a pre-built tree directly
resp = client.index_json("doc-123", tree=[...])

# Batch reindex (up to 100 files, plan-gated concurrency)
resp = client.index_batch(["doc-1", "doc-2"])

# Retry only failed pages of a partial document
resp = client.retry_failed_pages(upload.file_id)

# Cancel in-flight indexing
resp = client.cancel_indexing([upload.file_id])

# Wipe derived state without new bytes (replace flow)
resp = client.reset_index(upload.file_id)
```

### Wait for Indexing

```python
# Poll until ready (default: 600s timeout)
status = client.wait_for_indexing(upload.file_id, timeout=300)
print(f"Ready: {status.ready}, Progress: {status.progress_pct}%")
# Raises RuntimeError on error/cancelled, TimeoutError on expiry
```

### Get Document Status

```python
status = client.get_document_status(upload.file_id)
print(f"Pages: {status.processed_pages}/{status.total_pages}")
print(f"Tree version: {status.tree_version}")
```

### List Documents

```python
docs = client.list_documents()
for doc in docs:
    print(f"{doc['fileId']}: {doc.get('filename')} ({doc.get('status')})")
```

### Tree / Node Map / Excel Preview

```python
tree = client.get_document_tree(upload.file_id)
for node in tree:
    print(f"  {node.node_id}: {node.title}")

node_map = client.get_node_map(upload.file_id)
preview = client.get_excel_preview(upload.file_id)  # Excel files
for sheet in preview["sheets"]:
    print(f"  {sheet['name']}: {sheet['headers']}")
```

### Pages / Images / Original

```python
# List all pages
pages = client.get_document_pages(upload.file_id)
for page in pages:
    print(f"  Page {page.page_num}: {page.status}")

# Page markdown
content = client.get_page_content(upload.file_id, page_num=1)
print(content.markdown)

# Page JPEG (+ total page count header)
image = client.get_page_image(upload.file_id, page_num=1)
print(image["total_pages"], len(image["content"]))

# Original uploaded file
original = client.get_original(upload.file_id)
```

### Delete / Reprocess

```python
client.delete_document(upload.file_id)
client.reprocess_document(upload.file_id)
```

## Chats

### Create / List / Get / Update / Delete

```python
# Create (idempotent)
chat = client.create_chat("research-chat", display_name="Research Chat")
print(chat.id)

# List all
chats = client.list_chats()

# Get one
chat = client.get_chat("research-chat")

# Update metadata
client.update_chat("research-chat", title="New title")

# Delete
client.delete_chat("research-chat")
```

### Attach / Detach Documents

```python
# Attach multiple documents (rebuilds the knowledge graph)
client.attach_documents("research-chat", ["file_abc", "file_def"])

# Detach a document
client.detach_document("research-chat", "file_abc")
```

### Message History

```python
result = client.get_messages("research-chat", limit=20)
for msg in result["messages"]:
    print(f"  [{msg.role}] {msg.content[:100]}")

# Paginate
if result["has_more"]:
    older = client.get_messages("research-chat", limit=20, before=result["messages"][-1].msg_id)

# Save / edit / delete
client.save_message("research-chat", role="user", content="Hello")
client.edit_message("research-chat", msg_id="m1", message="Edited question")
client.update_message("research-chat", msg_id="m2", fields={"content": "Fixed answer"})
client.delete_message("research-chat", msg_id="m3")
```

### Cancel / Retry / Diagnose

```python
# Cancel a streaming turn
client.cancel_chat_message("research-chat", msg_id="streaming-id")

# Prepare a retry, then stream again with the returned ids
client.retry_chat_message("research-chat", msg_id="user-msg-id")

# Inspect a message (steps, citations, buffer state)
client.diagnose_message("research-chat", msg_id="m1")
```

### Artifacts / Outputs / Titles

```python
# Download a run artifact (parsed JSON dict)
artifact = client.get_run_artifact("research-chat", msg_id="m1", artifact_id="artifact_1")

# Download an archived structured output
raw = client.download_output("research-chat", session_id="s1", filename="result.json")

# Consolidate session memories
client.consolidate_memories("research-chat")

# Generate a chat title
title = client.generate_title("quarterly revenue analysis")
```

## Chat Streaming

SSE is the streaming transport for the hosted service.
`chat_stream_sse` opens
`POST /v1/chats/{chat_id}/stream`; consume it with `async for`:

```python
async for event in client.chat_stream_sse("research-chat", "What are the key findings?"):
    if event.type == "thinking":
        print(f"  {event.text}", end="")
    elif event.type == "answer":
        print(f"  {event.text}", end="")
    elif event.type == "citation":
        print(f"\n  Source: {event.citation.filename} p.{event.citation.start_page}")
    elif event.type == "done":
        print(f"\n  Tokens: {event.usage.total_tokens}")
    elif event.type == "error":
        print(f"\n  Error: {event.error}")

# Optional model override for the turn
async for event in client.chat_stream_sse(
    "research-chat", "Compare these", model="...",
):
    ...

# Retry an existing turn
client.retry_chat_message("research-chat", msg_id=user_msg_id)
async for event in client.chat_stream_sse(
    "research-chat", "",
    parent_msg_id=user_msg_id, retry_msg_id=assistant_msg_id,
):
    ...

# Resume a dropped SSE stream
async for event in client.chat_reconnect_sse("research-chat", streaming_msg_id, last_seq=12):
    ...
```

On the `done` event, `event.usage` is a `UsageInfo` with `prompt_tokens`,
`completion_tokens`, `total_tokens`, `calls`, and `thinking_tokens`.

For direct-to-service deployments where WebSocket upgrades are available, the
WebSocket variants behave the same way. They cannot connect through the hosted
service:

```python
async for event in client.chat_stream("research-chat", "What are the key findings?"):
    ...

# With per-turn attachments
async for event in client.chat_stream(
    "research-chat", "Compare these",
    attached_docs=[{"id": "file_abc", "name": "report.pdf"}],
):
    ...

# Resume a dropped stream
async for event in client.chat_reconnect("research-chat", streaming_msg_id, last_seq=12):
    ...

# Cancel the current turn and start a new one
async for event in client.chat_interrupt("research-chat", "Actually, do X instead"):
    ...
```

## Reasoning RAG Query

Direct query over documents without a chat:

```python
# Query a single document
resp = client.query(
    "What is the revenue growth?",
    file_id="file_abc123",
)
print(resp.answer)
print(f"Reasoning: {resp.reasoning_traces}")
print(f"Sub-questions: {resp.sub_questions}")
print(f"Nodes retrieved: {resp.nodes_retrieved}")

# Query multiple documents
resp = client.query(
    "Compare revenue across these reports",
    file_ids=["file_abc", "file_def"],
)

# With image context
resp = client.query(
    "Describe the charts",
    file_id="file_abc",
    include_images=True,
)

# With conversation continuity
resp = client.query(
    "Now tell me about expenses",
    file_id="file_abc",
    session_id="session-123",
    message_id="msg-456",
)
```

### Cancel a Query

```python
client.cancel_query(session_id="session-123", message_id="msg-456")
```

## Codegen / Tables / Models

```python
# Generate (+ execute for excel_index) code for a document
result = client.generate_code("research-chat", "file_abc", task="excel_index")
print(result.code_id, result.output)

codes = client.list_codes("research-chat")
code = client.get_code("research-chat", result.code_id)
client.put_code("research-chat", result.code_id, code="...", fork=True)
client.predict({...})  # tabular prediction passthrough
client.get_artifact("research-chat", "my-artifact")

# Tables
client.synthesize_table("file_abc", pages=[1, 2])
client.get_toc("file_abc")

# Models (server-side defaults; optional per-chat/stream overrides)
client.list_models()
```

## Low-Level Escape Hatch

```python
# For endpoints the SDK doesn't wrap yet
data = client._raw_request("GET", "/v1/some-route", params={"file_id": "x"})
```

## Error Handling

```python
from httpx import HTTPStatusError

try:
    client.get_chat("my-chat")
except HTTPStatusError as e:
    if e.response.status_code == 404:
        print("Chat not found")
    elif e.response.status_code == 401:
        print("Invalid credentials")
    else:
        print(f"HTTP {e.response.status_code}: {e.response.text}")
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCWORM_API_KEY` | - | DocWorm API key (`dw_live_...`) |
| `DOCWORM_URL` | hosted DocWorm service | Service base URL |

## License

Apache 2.0 - see [LICENSE](https://github.com/Hopperbase/docworm-sdk/blob/main/LICENSE).
