# Changelog

All notable changes to the DocWorm SDK are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-11-03

### Added
- Python `chat_stream_sse` / `chat_reconnect_sse`: stream a chat turn and
  replay missed events over `POST /v1/chats/{chat_id}/stream` (SSE) for the
  hosted service, where a WebSocket upgrade is unavailable.
- TypeScript `chatStreamSse` / `chatReconnectSse`: the same SSE streaming
  methods for the hosted service.

### Packaging
- PyPI-ready metadata: `LICENSE` and `NOTICE` are now shipped inside the sdist
  and wheel, the license is declared as the SPDX expression `Apache-2.0`, and
  `docworm.__version__` is the single source of truth for the version.
- Type information is declared via a bundled `py.typed` marker; keywords and a
  changelog URL are published in the project metadata.
- The sdist no longer ships `tests/`.

## [Unreleased]

### Fixed
- `put_code` / `putCode` accept an optional `source` field.
- `edit_message` / `editMessage` accept `message` or `content`.
- Python `get_run_artifact` returns parsed JSON, matching the REST contract
  and the TypeScript client.
- Added `delete_file` / `deleteFile` alias (`DELETE /v1/files/{file_id}`).

### Repository
- `config.yaml` is no longer tracked. Copy `config.yaml.example` to
  `config.yaml` for local configuration.

## [0.5.0] — 2026-09-21

Public SDK surface across Python and TypeScript: documents, chats
(WebSocket-only streaming), reasoning RAG `query`, codegen, tables, models,
and skills.

## [0.4.0] — 2026-09-13

Hard rename to backend identifiers, WebSocket chat, and full endpoint parity.
**Breaking: `doc_id`/`agent_id` names, REST chat methods, and per-request model
overrides are removed with no aliases.** Client coverage follows backend
truth (`services/docworm/routes/*`).

### Removed (breaking)
- `doc_id` → `file_id` and `agent_id` → `chat_id` everywhere (methods, bodies,
  response models, docs, examples). No backward-compatible aliases.
- REST chat: Python `chat()` / TS `chat()` (non-streaming `POST .../chat`) and
  the SSE `chat_stream`/`chatStream` over `POST .../chat/stream` — that
  endpoint never existed; chat is WebSocket-only.
- Per-request model overrides (`chat_model`, `chat_provider`, `vlm_model`) in
  constructors, methods, and config. Models resolve server-side from
  `model_configs/active`; use `list_models()` for discovery.
- Python `QueryResponse.retrieved_node_ids` / `excel_row_node_ids` — the
  backend never returns them. Benchmark harnesses should use `_raw_request` /
  `rawRequest`.
- Python `AgentInfo` / `create_agent` / `get_agent` / `delete_agent` /
  `list_agents` — replaced by `ChatInfo` / `create_chat` / `get_chat` /
  `update_chat` / `delete_chat` / `list_chats`.

### Added
- WebSocket chat: `chat_stream` / `chatStream` (plus `chat_reconnect`,
  `chat_interrupt` / `chatReconnect`, `chatInterrupt`) over
  `WS /v1/chats/{chat_id}/chat` with auth-first framing, retry ids, and typed
  `ChatEvent`s (`thinking`, `answer`, `citation`, `action`, `trace`, `done`,
  `error`, …).
- Documents: `index_batch`, `retry_failed_pages`, `cancel_indexing`,
  `reset_index`, `index_json` (now also in TS), `get_node_map`,
  `get_excel_preview`, `get_page_image`, `get_original`; `index()` accepts an
  optional file for one-step upload+index; `upload()`/`index()` accept
  `project_id`/`chat_id`/`folder_id` scoping.
- Chats: `update_chat`, full message CRUD (`save/edit/update/delete_message`),
  `cancel_chat_message`, `retry_chat_message`, `get_run_artifact`,
  `diagnose_message`, `consolidate_memories`, `download_output`,
  `generate_title`, `register_chat_file`.
- Codegen (`generate_code`, `list/get/put_code`, `predict`, `get_artifact`,
  `codegen_health`), tables (`synthesize_table`, `get_toc`), models
   (`list_models`), skills (`generate_skill`).
- TS `rawRequest` public escape hatch (parity with Python `_raw_request`).
- `wait_for_indexing` / `waitForIndexing` now fail fast on `error`/`failed` /
  `cancelled` instead of polling until timeout; Python raises `RuntimeError`,
  TS throws `DocWormError(422)`.

### Fixed
- TS `upload`/`index` moved to the real `POST /v1/upload` + `POST /v1/index`
  (Form `file_id`); the `/v1/documents/upload`, `/v1/documents/{id}/index`,
  and `.../pages/{n}/content` paths never existed.
- TS `attachDocuments`/`detachDocument` moved to `POST /v1/chats/{id}/attach`
  (`{file_ids}`) + `POST /v1/chats/{id}/detach` (`{file_id}`); the
  `/v1/agents/*` namespace never existed.
- Python `query()` body fixed to `{query, file_id, file_ids, includeImages,
  inlineImages, sessionId, messageId, rootCollection}`; TS `query()` fixed to
  the same body (was `{question}` + query-params).
- Response parsing fixed to wire shapes: `{documents}`, `{chats}`,
  `{messages, has_more}`, `{tree}`, `{pages}`, camelCase status
  (`fileId`, `totalPages`, `treeVersion`).
- `QueryResponse.sub_questions` is a list (spec/TS `integer` was a bug).
- Python `create_agent` sent query-params the backend never accepted.
- `upload_and_index` / `uploadAndIndex` aligned: both return the queued
  `IndexResponse` immediately (call `wait_for_indexing` to block).
- `config.py` YAML fallback never ran when PyYAML was missing (fixed).
- Docs/examples: `upload.total_pages`, sync-`for` over the async WS
  generator, `list_documents()` attribute access, and stale `vlm_model`
  config examples all corrected.

## [0.3.0a1] — 2026-07-24

Prerelease companion to the `docworm-bench` harness. Superseded by 0.4.0 —
see above. (Its CHANGELOG claims about `/v1/documents/*` URL paths described
routes that never existed on the backend; the TS paths from that release are
corrected in 0.4.0.)
