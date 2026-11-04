"""
DocWorm Python SDK — Quick Start Example

Usage:
    pip install docworm
    export DOCWORM_API_KEY=your-api-key
    export DOCWORM_URL=https://docworm.web.app  # optional
    python examples/python/quickstart.py
"""

import asyncio
import os
import sys

from docworm import DocWorm

# Credentials come from the environment; DOCWORM_URL is optional.
api_key = os.getenv("DOCWORM_API_KEY", "").strip()
if not api_key:
    sys.exit(
        "error: DOCWORM_API_KEY is not set - export it before running this example"
        " (see the Environment Variables section of README.md)."
    )

# Initialize the client explicitly (no implicit config file discovery)
client = DocWorm(
    api_key=api_key,
    base_url=os.getenv("DOCWORM_URL", "https://docworm.web.app"),
)


async def main() -> None:
    # Upload a document
    upload = client.upload("path/to/report.pdf")
    print(f"Uploaded: {upload.file_id} ({upload.filename})")

    # Start indexing and wait until ready
    client.index(upload.file_id)
    print("Indexing started...")
    status = client.wait_for_indexing(upload.file_id, timeout=300)
    print(f"Indexed: {status.processed_pages}/{status.total_pages} pages")

    # Create a chat and attach the document
    chat = client.create_chat("research-chat", display_name="Research Chat")
    print(f"Created chat: {chat.id}")
    client.attach_documents("research-chat", [upload.file_id])
    print("Document attached")

    # Chat streaming over SSE; the WebSocket chat_stream targets direct-to-service deployments.
    print("\n--- Streaming ---")
    async for event in client.chat_stream_sse("research-chat", "Summarize the document"):
        if event.type == "thinking":
            print(f"  {event.text}", end="")
        elif event.type == "answer":
            print(f"  {event.text}", end="")
        elif event.type == "citation":
            c = event.citation
            print(f"\n  Source: {c.filename} p.{c.start_page}-{c.end_page}")
        elif event.type == "done":
            print(f"\nDone (tokens: {event.usage.total_tokens})")
        elif event.type == "error":
            print(f"\nError: {event.error}")

    # Reasoning RAG query (no chat needed)
    print("\n--- Query ---")
    resp = client.query(
        "What is the revenue growth?",
        file_id=upload.file_id,
    )
    print(f"Answer: {resp.answer}")
    print(f"Sub-questions: {resp.sub_questions}")
    print(f"Nodes retrieved: {resp.nodes_retrieved}")


if __name__ == "__main__":
    asyncio.run(main())
