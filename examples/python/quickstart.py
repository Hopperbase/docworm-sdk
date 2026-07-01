"""
DocWorm Python SDK — Quick Start Example

Usage:
    pip install docworm
    export DOCWORM_API_KEY=your-api-key
    python examples/python/quickstart.py
"""

import asyncio

from docworm import DocWorm

# Initialize client (api_key also reads DOCWORM_API_KEY env var)
client = DocWorm(api_key="your-api-key")


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

    # Chat streaming (WebSocket) — consume with async for
    print("\n--- Streaming ---")
    async for event in client.chat_stream("research-chat", "Summarize the document"):
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
