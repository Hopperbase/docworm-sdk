# DocWorm SDK

Official SDKs for the DocWorm service — document indexing, knowledge graphs, reasoning RAG, and chat.

## Quick Start

### Python

```bash
pip install docworm
```

```python
import asyncio
from docworm import DocWorm

client = DocWorm(api_key="your-api-key")  # Firebase ID token or dw_live_ key
upload = client.upload("report.pdf")
client.index(upload.file_id)
client.wait_for_indexing(upload.file_id)

client.create_chat("research-chat", display_name="Research")
client.attach_documents("research-chat", [upload.file_id])

async def main():
    async for event in client.chat_stream("research-chat", "What does this document say?"):
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

const client = new DocWorm({ apiKey: "your-api-key" }); // Firebase ID token or dw_live_ key
const upload = await client.upload(file);
await client.index(upload.file_id);
await client.waitForIndexing(upload.file_id);

await client.createChat("research-chat", { display_name: "Research" });
await client.attachDocuments("research-chat", [upload.file_id]);

for await (const event of client.chatStream("research-chat", "What does this document say?")) {
  if (event.type === "answer") process.stdout.write(event.text!);
  else if (event.type === "done") console.log("\nDone");
}
```

## Using DocWorm

```python
client = DocWorm(api_key="your-api-key")
```

```typescript
const client = new DocWorm({ apiKey: "your-api-key" });
```

Models resolve server-side from the `model_configs/active` document — there are
no per-request model parameters. Use `client.list_models()` to inspect the
active defaults.

## Chat Is WebSocket-Only

There is no REST chat endpoint. `chat_stream` / `chatStream` open
`WS /v1/chats/{chat_id}/chat` (auth frame first, then a `chat` frame) and yield
typed events: `thinking`, `answer`, `citation`, `action`, `trace`, `done`, `error`
(see `ChatEvent`). Retry an existing turn with `retry_chat_message()` +
`parent_msg_id`/`retry_msg_id`, or resume a dropped stream with `chat_reconnect()`.

## Config File

The SDK automatically loads configuration from `config.yaml` in these locations (in order of precedence):

1. Constructor arguments (highest priority)
2. Environment variables (`DOCWORM_API_KEY`)
3. `./config.yaml` (current directory)
4. `~/.config/docworm/config.yaml`
5. `config.yaml` in the SDK package root

Example `config.yaml`:

```yaml
api_key: "your-api-key"
base_url: "https://docworm.web.app"
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DOCWORM_API_KEY` | Firebase ID token or `dw_live_` API key | — |

## API Coverage

Documents (`upload`, `index`, `index_json`, `index_batch`, `retry_failed_pages`,
`cancel_indexing`, `reset_index`, status/pages/tree/node-map/excel-preview/images),
chats (CRUD, attach/detach, full message history CRUD, cancel/retry, run
artifacts, outputs, titles), reasoning RAG `query`, codegen, tables, models,
skills.

## License

Apache 2.0 — see [LICENSE](LICENSE).

## Support

- [GitHub Issues](https://github.com/Hopperbase/docworm-sdk/issues)
