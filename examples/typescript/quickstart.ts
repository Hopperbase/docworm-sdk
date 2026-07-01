/**
 * DocWorm TypeScript SDK — Quick Start Example
 *
 * Usage:
 *   npm install @docworm/sdk
 *   export DOCWORM_API_KEY=your-api-key
 *   npx tsx examples/typescript/quickstart.ts
 */

import { DocWorm } from "@docworm/sdk";
import { readFileSync } from "fs";

// Initialize client (apiKey also reads DOCWORM_API_KEY env var)
const client = new DocWorm({
  apiKey: process.env.DOCWORM_API_KEY || "your-api-key",
});

async function main() {
  // Upload a document
  const buffer = readFileSync("path/to/report.pdf");
  const upload = await client.upload(buffer, { filename: "report.pdf" });
  console.log(`Uploaded: ${upload.file_id} (${upload.filename})`);

  // Start indexing and wait until ready
  await client.index(upload.file_id);
  console.log("Indexing started...");
  const status = await client.waitForIndexing(upload.file_id, { timeout: 300 });
  console.log(`Indexed: ${status.processedPages}/${status.totalPages} pages`);

  // Create a chat and attach the document
  const chat = await client.createChat("research-chat", { display_name: "Research Chat" });
  console.log(`Created chat: ${chat.id ?? "research-chat"}`);
  await client.attachDocuments("research-chat", [upload.file_id]);
  console.log("Document attached");

  // Chat streaming (WebSocket) — consume with for await
  console.log("\n--- Streaming ---");
  for await (const event of client.chatStream("research-chat", "Summarize the document")) {
    if (event.type === "thinking") {
      process.stdout.write(event.text!);
    } else if (event.type === "answer") {
      process.stdout.write(event.text!);
    } else if (event.type === "citation") {
      console.log(`\n  Source: ${event.citation!.filename} p.${event.citation!.start_page}`);
    } else if (event.type === "done") {
      console.log(`\nDone (tokens: ${event.usage?.total_tokens ?? 0})`);
    } else if (event.type === "error") {
      console.error(`\nError: ${event.error}`);
    }
  }

  // Reasoning RAG query (no chat needed)
  console.log("\n--- Query ---");
  const queryResp = await client.query("What is the revenue growth?", {
    file_id: upload.file_id,
  });
  console.log(`Answer: ${queryResp.answer}`);
  console.log(`Sub-questions: ${queryResp.sub_questions}`);
  console.log(`Nodes retrieved: ${queryResp.nodes_retrieved}`);
}

main().catch(console.error);
