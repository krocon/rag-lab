# @raglab/mcp – RAGLab MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives MCP clients
(Claude Desktop, Claude Code and other MCP hosts) **read-only** access to RAGLab knowledge bases.
It runs locally over **stdio** and talks to the RAGLab API over HTTP – it has no database or model
access of its own (decision: [ADR 0003](../../docs/adr/0003-mcp-server.md)).

```text
MCP client ──stdio (JSON-RPC)──▶ apps/mcp ──HTTP──▶ apps/api (:3000) ──▶ PostgreSQL / Ollama
```

## Tools

| Tool               | Input                                                 | Result                                                                                                                          |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `list_collections` | –                                                     | ID, name, description, document/ready/chunk counts, embedding provider/model/dimensions                                         |
| `search_knowledge` | `collection` (ID or name), `query`, `topK?` (1–20)    | hits with `rank`, `score` (1 − distance), `distance` (cosine), file name, heading path, `documentId`, `chunkId`, text           |
| `get_document`     | `documentId`, `chunkId?`, `maxChars?`                 | metadata and full text (shortened to `maxChars`), or one chunk with up to 1 000 characters of context on each side              |
| `ask_knowledge`    | `collection` (ID or name), `question`, `topK?` (1–20) | answer of RAGLab's chat (`POST /api/chat`), numbered sources, `citedSources`, `unknownCitations`, `answerStatus` (`no_sources`) |

Every tool returns readable text (`content`) **and** `structuredContent` that matches its
`outputSchema`. Collection names are matched case-insensitively and exactly; an unknown or
ambiguous name returns a tool error listing the available collections. API errors become tool
results with `isError: true` and the API's error code (e.g. `VALIDATION_ERROR`, `RATE_LIMITED`,
`EMBEDDING_PROVIDER_UNAVAILABLE`, `API_UNREACHABLE`); the server keeps running.

### Untrusted content

Document text, file names, headings and generated answers come from uploaded documents and are
**untrusted**. MCP clients usually pass tool results to a model that can call further tools, so
a manipulated document could try to steer that model (indirect prompt injection). The server
therefore

- only offers read-only tools,
- prefixes document content with a notice to treat it as data, not instructions,
- encloses every excerpt in `<<<BEGIN UNTRUSTED CONTENT id>>>` / `<<<END UNTRUSTED CONTENT id>>>`
  markers with a random `id` per tool call (text cannot close the block early),
- limits every result to `MCP_MAX_OUTPUT_CHARS` and says when something was shortened.

This reduces, but does not prevent, prompt injection – review what your MCP client does with the
results. Details: [docs/security.md](../../docs/security.md) §11.

## Setup

1. Start the RAGLab API (`pnpm db:up && pnpm dev:api`, see the root README) and index documents.
2. Build the server: `pnpm build:mcp` (or `pnpm --filter @raglab/mcp build`).
3. Register it in your MCP client with **`node`** and the absolute path to `dist/main.js`. Do not use
   `pnpm start` as the command: pnpm prints to stdout, which belongs to the protocol.

`/abs/path/to/rag-lab` below is a placeholder for your clone.

**Claude Code:**

```bash
claude mcp add raglab -- node /abs/path/to/rag-lab/apps/mcp/dist/main.js
# with a different API URL:
claude mcp add raglab --env RAGLAB_API_URL=http://127.0.0.1:3000 -- node /abs/path/to/rag-lab/apps/mcp/dist/main.js
```

**Claude Desktop** (`claude_desktop_config.json`, Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "raglab": {
      "command": "node",
      "args": ["/abs/path/to/rag-lab/apps/mcp/dist/main.js"],
      "env": { "RAGLAB_API_URL": "http://127.0.0.1:3000" }
    }
  }
}
```

Other MCP hosts work the same way (command `node`, the path as argument). To try the tools
interactively, the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) can start the
same command.

## Configuration

Environment variables (validated at startup; invalid values abort with a list of errors on
stderr). The repository-root `.env` is loaded as well; variables set by the MCP client win.

| Variable                 | Default                 | Purpose                                                                     |
| ------------------------ | ----------------------- | --------------------------------------------------------------------------- |
| `RAGLAB_API_URL`         | `http://127.0.0.1:3000` | Base URL of the RAGLab API (http/https, no credentials, no query)           |
| `MCP_MAX_OUTPUT_CHARS`   | `20000`                 | Upper bound for the text of one tool result (2 000–200 000)                 |
| `MCP_REQUEST_TIMEOUT_MS` | `90000`                 | Timeout of one API request (above the API's `EMBEDDING_TIMEOUT_MS` default) |
| `MCP_CHAT_TIMEOUT_MS`    | `300000`                | Timeout of a whole `ask_knowledge` call (retrieval + streamed answer)       |

The API's protections apply unchanged: requests carry no `Origin` header (server-to-server, so the
CSRF check does not apply), the `Host` header comes from `RAGLAB_API_URL` and must be in the API's
`ALLOWED_HOSTS` (the loopback defaults are), and the API's rate limits count MCP requests like any
other client's (search and ask resolve the collection with an extra `GET /api/collections`;
`get_document` makes two or three `GET` requests).

## Logging

Logs go to **stderr only** (stdout carries JSON-RPC); ESLint forbids `console` and
`process.stdout` in `src/`. Log lines contain tool names, error codes and timings – never queries,
questions, document text or answers.

## Development

```bash
pnpm --filter @raglab/mcp dev        # run from source (tsx), stdio
pnpm --filter @raglab/mcp test       # unit + protocol tests (in-memory transport, fake API)
pnpm --filter @raglab/mcp lint
pnpm --filter @raglab/mcp typecheck
```

Tests never need a running API: tool tests use the SDK's `InMemoryTransport` with a fake client,
the client tests a mocked `fetch`, and `test/stdio.test.ts` starts the real entry point as a child
process against a local fake HTTP API.

## Not included (yet)

- Streamable HTTP transport (remote MCP) – needs authentication and Host/Origin checks; planned.
- Write tools (upload, delete, create collections), MCP resources and prompts – planned.
