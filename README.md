# DocWorm SDK

Official SDKs for the DocWorm service — document indexing, knowledge graphs, reasoning RAG, and chat.

## Documentation

Full documentation lives in [`docs/`](docs/) and is built with [Mintlify](https://mintlify.com).
Run `scripts/docs.sh` to regenerate the SDK API reference artifacts and validate the site;
for a live preview, run `npx mint dev` from `docs/`.

## Quick Start

### Python

```bash
pip install docworm
```

```python
import asyncio
from docworm import DocWorm

client = DocWorm(api_key="dw_live_...")  # or set DOCWORM_API_KEY env var
upload = client.upload("report.pdf")
client.index(upload.file_id)
client.wait_for_indexing(upload.file_id)

client.create_chat("research-chat", display_name="Research")
client.attach_documents("research-chat", [upload.file_id])

async def main():
    async for event in client.chat_stream_sse("research-chat", "What does this document say?"):
        if event.type == "answer":
            print(event.text, end="")
        elif event.type == "done":
            print("\nDone")

asyncio.run(main())
```

### TypeScript

```bash
npm install @docworm/sdk
```

```typescript
import { DocWorm } from "@docworm/sdk";

const client = new DocWorm({ apiKey: "dw_live_..." }); // or DOCWORM_API_KEY env var
const upload = await client.upload(file);
await client.index(upload.file_id);
await client.waitForIndexing(upload.file_id);

await client.createChat("research-chat", { display_name: "Research" });
await client.attachDocuments("research-chat", [upload.file_id]);

for await (const event of client.chatStreamSse("research-chat", "What does this document say?")) {
  if (event.type === "answer") process.stdout.write(event.text!);
  else if (event.type === "done") console.log("\nDone");
}
```

## Using DocWorm

```python
client = DocWorm(api_key="dw_live_...")
```

```typescript
const client = new DocWorm({ apiKey: "dw_live_..." });
```

Models resolve server-side from the `model_configs/active` document by default;
omit `model` to use the active defaults. Optional `model` overrides are
supported on chat creation/update and on SSE streaming. Use
`client.list_models()` (Python) or `client.listModels()` (TypeScript) to
inspect the active defaults.

## Chat Streaming

SSE is the standard streaming path for the hosted service
(`https://docworm.web.app`), where WebSocket upgrades are unavailable.
`chat_stream_sse` / `chatStreamSse` open
`POST /v1/chats/{chat_id}/stream` and yield typed events (`thinking`,
`answer`, `citation`, `done`, `error`; see `ChatEvent`). Resume a dropped
stream with `chat_reconnect_sse()` / `chatReconnectSse()`.

```python
async for event in client.chat_stream_sse("research-chat", "Summarize this"):
    if event.type == "answer":
        print(event.text, end="")
```

```typescript
for await (const event of client.chatStreamSse("research-chat", "Summarize this")) {
  if (event.type === "answer") process.stdout.write(event.text ?? "");
}
```

For direct-to-service deployments, where WebSocket upgrades are available,
`chat_stream` / `chatStream` open `WS /v1/chats/{chat_id}/chat` (auth frame
first, then a `chat` frame) and yield the same event types. Retry an existing
turn with `retry_chat_message()` + `parent_msg_id`/`retry_msg_id`, resume a
dropped stream with `chat_reconnect()` / `chatReconnect()`, or replace the
current turn with `chat_interrupt()` / `chatInterrupt()`.

## Config File

Copy `config.yaml.example` to `./config.yaml` (or
`~/.config/docworm/config.yaml`) for local file configuration.

The SDK loads configuration from these sources (in order of precedence):

1. Constructor arguments (highest priority)
2. Environment variables (`DOCWORM_API_KEY`, `DOCWORM_URL`)
3. `./config.yaml` (current directory)
4. `~/.config/docworm/config.yaml`
5. `config.yaml` in the SDK package root

Example `config.yaml`:

```yaml
api_key: "dw_live_..."
base_url: "https://docworm.web.app"
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DOCWORM_API_KEY` | DocWorm API key (`dw_live_...`) | - |
| `DOCWORM_URL` | Service base URL | `https://docworm.web.app` |

## API Coverage

Documents (`upload`, `index`, `index_json`, `index_batch`, `retry_failed_pages`,
`cancel_indexing`, `reset_index`, status/pages/tree/node-map/excel-preview/images),
chats (CRUD, attach/detach, full message history CRUD, cancel/retry, run
artifacts, outputs, titles), reasoning RAG `query`, codegen, tables, models.

## License

Apache 2.0 — see [LICENSE](LICENSE).

## Support

- [GitHub Issues](https://github.com/Hopperbase/docworm-sdk/issues)
