# DocWorm TypeScript SDK

TypeScript/JavaScript SDK for the DocWorm service.

Full documentation: see the `docs/` folder at the repository root (Mintlify-powered).

## Installation

```bash
npm install @docworm/sdk
```

The package installs the `ws` dependency automatically for WebSocket streaming
fallback on Node < 22.

## Quick Start

```typescript
import { DocWorm } from "@docworm/sdk";

const client = new DocWorm({
  apiKey: "dw_live_...", // or DOCWORM_API_KEY env var
});

// Upload and index a document
const upload = await client.upload(file);
await client.index(upload.file_id);
await client.waitForIndexing(upload.file_id);

// Create a chat and attach documents
await client.createChat("my-chat", { display_name: "My Chat" });
await client.attachDocuments("my-chat", [upload.file_id]);

// Stream a chat turn over SSE
for await (const event of client.chatStreamSse("my-chat", "What does the document say?")) {
  if (event.type === "answer") process.stdout.write(event.text!);
  else if (event.type === "citation")
    console.log(`\nSource: ${event.citation!.filename} p.${event.citation!.start_page}`);
  else if (event.type === "done") console.log("\nDone");
}
```

## Configuration

```typescript
const client = new DocWorm({
  apiKey: "dw_live_...", // or DOCWORM_API_KEY env var
});
```

Authenticate with a DocWorm API key (`dw_live_...`, sent via `X-API-KEY`). Copy
`config.yaml.example` to `config.yaml` for local file configuration.

Models resolve server-side from `model_configs/active` by default; use
`client.listModels()` to inspect the active defaults. Optional `model`
overrides are supported on chat creation and `chatStreamSse`. In Node < 22,
WebSocket chat streaming uses the bundled `ws` fallback automatically.

## Documents

```typescript
// Upload from file path / Buffer / File
const upload = await client.upload(file, { filename: "report.pdf" });
const upload = await client.upload(buffer, { filename: "report.pdf" });
const upload = await client.upload("report.pdf"); // Node: reads from disk

// Index (usually status="queued")
await client.index(upload.file_id);

// Upload + index in one call (returns the queued IndexResponse)
const queued = await client.uploadAndIndex(file);

// One-step upload + index with an explicit id
await client.index("file-123", { file, filename: "report.pdf" });

// Pre-built tree / batch / retry / cancel / reset
await client.indexJson("file-123", tree);
await client.indexBatch(["file-1", "file-2"]);
await client.retryFailedPages("file-123");
await client.cancelIndexing(["file-123"]);
await client.resetIndex("file-123");

// Check status (throws on error/cancelled, 408 on timeout)
const status = await client.waitForIndexing("file_123", { timeout: 300 });

// List all documents
const docs = await client.listDocuments();

// Tree / node map / Excel preview
const tree = await client.getDocumentTree("file_123");
const nodeMap = await client.getNodeMap("file_123");
const preview = await client.getExcelPreview("file_123");

// Pages / images / original
const pages = await client.getDocumentPages("file_123");
const content = await client.getPageContent("file_123", 1);
const image = await client.getPageImage("file_123", 1); // { content, contentType, totalPages }
const file = await client.getOriginal("file_123");      // { content, contentType, filename }

// Delete / reprocess
await client.deleteDocument("file_123");
await client.reprocessDocument("file_123");

// Low-level escape hatch
await client.rawRequest("GET", "/v1/some-route", { params: { file_id: "x" } });
```

## Chats

```typescript
// Create (idempotent) / list / get / update / delete
const chat = await client.createChat("research", { display_name: "Research Chat" });
const chats = await client.listChats();
const one = await client.getChat("research");
await client.updateChat("research", { title: "New title" });
await client.deleteChat("research");

// Attach / detach documents (rebuilds the knowledge graph)
await client.attachDocuments("research", ["file_abc", "file_def"]);
await client.detachDocument("research", "file_abc");

// Message history ({ messages, has_more })
const { messages, has_more } = await client.getMessages("research", { limit: 20 });
await client.saveMessage("research", { role: "user", content: "Hello" });
await client.editMessage("research", "m1", "Edited question");
await client.updateMessage("research", "m2", { content: "Fixed answer" });
await client.deleteMessage("research", "m3");

// Cancel / retry / diagnose
await client.cancelChatMessage("research", "streaming-id");
await client.retryChatMessage("research", "user-msg-id");
await client.diagnoseMessage("research", "m1");

// Artifacts / outputs / memories / titles
await client.getRunArtifact("research", "m1", "artifact_1");
await client.downloadOutput("research", "s1", "result.json");
await client.consolidateMemories("research");
await client.generateTitle("quarterly revenue analysis");
```

## Chat Streaming

SSE is the streaming transport for the hosted service.
`chatStreamSse` opens
`POST /v1/chats/{chat_id}/stream`:

```typescript
for await (const event of client.chatStreamSse("research", "Summarize the document")) {
  if (event.type === "thinking") {
    process.stdout.write(event.text!);
  } else if (event.type === "answer") {
    process.stdout.write(event.text!);
  } else if (event.type === "citation") {
    console.log(`\nSource: ${event.citation!.filename} p.${event.citation!.start_page}`);
  } else if (event.type === "done") {
    console.log(`\nDone (msg ${event.msg_id})`);
  } else if (event.type === "error") {
    console.error(`Error: ${event.error}`);
  }
}

// Optional per-turn options (ChatStreamSseOptions)
for await (const event of client.chatStreamSse("research", "Compare these", {
  model: "...",                 // optional model override
  orchestration: "auto",        // "auto" or "direct"
  parentMsgId: userMsgId,       // retry/edit context
  retryMsgId: assistantMsgId,
  baseMsgId: baseMsgId,
  signal: abortController.signal,
})) { /* ... */ }

// Retry an existing turn
await client.retryChatMessage("research", userMsgId);
for await (const event of client.chatStreamSse("research", "", {
  parentMsgId: userMsgId,
  retryMsgId: assistantMsgId,
})) { /* ... */ }

// Resume a dropped SSE stream
for await (const event of client.chatReconnectSse("research", streamingId, 12)) { /* ... */ }
```

On the `done` event, `event.usage` is a `TokenUsage` with `prompt_tokens`,
`completion_tokens`, `total_tokens`, `calls`, and `thinking_tokens`.

For direct-to-service deployments where WebSocket upgrades are available, use
`chatStream` (`WS /v1/chats/{chat_id}/chat`), `chatReconnect`, and
`chatInterrupt`. They cannot connect through the hosted service:

```typescript
for await (const event of client.chatStream("research", "Summarize the document")) { /* ... */ }

// Retry / resume / interrupt
await client.retryChatMessage("research", userMsgId);
for await (const event of client.chatStream("research", "", {
  parent_msg_id: userMsgId,
  retry_msg_id: assistantMsgId,
})) { /* ... */ }

for await (const event of client.chatReconnect("research", streamingId, 12)) { /* ... */ }
for await (const event of client.chatInterrupt("research", "Actually, do X")) { /* ... */ }
```

## Reasoning RAG Query

```typescript
// Query a single document
const resp = await client.query("What is the revenue growth?", {
  file_id: "file_abc",
});
console.log(resp.answer);
console.log(resp.reasoning_traces);

// Query multiple documents
const resp = await client.query("Compare revenue", {
  file_ids: ["file_abc", "file_def"],
});

// With image context
const resp = await client.query("Describe the charts", {
  file_id: "file_abc",
  include_images: true,
});

// With conversation continuity
const resp = await client.query("Now tell me about expenses", {
  file_id: "file_abc",
  session_id: "session-123",
  message_id: "msg-456",
});
```

### Cancel a Query

```typescript
await client.cancelQuery("session-123", "msg-456");
```

## Codegen / Tables / Models

```typescript
const result = await client.generateCode({ chat_id: "research", file_id: "file_abc" });
await client.listCodes("research");
await client.getCode("research", result.code_id);
await client.putCode("research", result.code_id, { code: "..." }, { fork: true });
await client.predict({ /* predictor payload */ });
await client.getArtifact("research", "my-artifact");

await client.synthesizeTable("file_abc", [1, 2]);
await client.getToc("file_abc");

await client.listModels();
```

## Error Handling

```typescript
import { DocWormError } from "@docworm/sdk";

try {
  await client.getChat("my-chat");
} catch (e) {
  if (e instanceof DocWormError) {
    if (e.status === 404) console.log("Chat not found");
    else if (e.status === 401) console.log("Invalid credentials");
    else console.log(`HTTP ${e.status}: ${e.body}`);
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCWORM_API_KEY` | - | DocWorm API key (`dw_live_...`) |
| `DOCWORM_URL` | hosted DocWorm service | Service base URL |

## License

Apache 2.0 - see [LICENSE](https://github.com/Hopperbase/docworm-sdk/blob/main/LICENSE).
