# Changelog

All notable changes to RAGLab are documented in this file. The format is based on
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and RAGLab follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). All packages of the monorepo (API, web
app, MCP server, shared types) share one version.

Add your change under **Unreleased** in the same pull request (sections `Added`, `Changed`,
`Deprecated`, `Removed`, `Fixed`, `Security`). `pnpm release:version <x.y.z>` turns it into a
release section; see [docs/release.md](docs/release.md) (German).

## [Unreleased]

First public version of RAGLab.

### Added

- **Knowledge bases:** collections with Markdown/TXT upload (multipart, `202 Accepted`), text
  normalisation, SHA-256 duplicate detection, document status with polling, reindexing and
  deletion.
- **Indexing pipeline:** deterministic, heading-aware chunking with offsets, heading path and
  overlap; embeddings via Ollama (`POST /api/embed`) with batching, timeouts and dimension checks;
  vectors in PostgreSQL 18 + pgvector 0.8.7 with an HNSW index.
- **Retrieval:** `POST /api/retrieval/search` with collection filter in SQL, top-K, distance and
  score; iterative HNSW scans.
- **Grounded chat:** `POST /api/chat` streamed as Server-Sent Events (`sources`, `token`, `done`,
  `error`), numbered sources, citation checks, `no_sources` without a model call.
- **Retrieval playground:** `POST /api/playground/search` with hits, chat context, statistics,
  warnings and prompt preview.
- **Web app (Angular 22):** knowledge bases, upload with progress, document and chunk views, chat
  with source cards and citation links, retrieval playground, settings and live system status.
- **MCP server (`apps/mcp`, stdio):** read-only tools `list_collections`, `search_knowledge`,
  `get_document` and `ask_knowledge`; document content marked as untrusted.
- **Evaluation:** bundled dataset (14 documents, 40 questions), Recall/Precision/Hit-Rate@K and MRR,
  `pnpm eval` with a lexical baseline for CI and an optional prompt-injection live check.
- **Operations:** OpenAPI 3.1 at `/api/docs`, liveness/readiness endpoints, structured logs with
  redaction, configuration validated at startup.
- **Demo:** self-written demo knowledge base `examples/demo-knowledge-base` (documentation of a
  fictional job scheduler, example questions, a clearly marked prompt-injection file) and
  `pnpm demo:seed`, which loads it through the REST API (idempotent, `--reset`, waits for indexing,
  clear errors when the API or Ollama is not reachable).
- **Documentation:** consolidated README with screenshots, pipeline diagram, quick start and
  limitations; updated CONTRIBUTING with test strategy and pull request checklist; German demo video
  script (`docs/demo/video-script.md`); `pnpm docs:links` checks relative links and anchors in all
  Markdown files (also in CI).
- **Containers and release:** non-root multi-stage images for API, web (nginx with SPA fallback,
  SSE-capable `/api` proxy, security and cache headers, gzip) and MCP server; a one-shot `migrate`
  compose service; health checks, restart policies, resource limits and read-only root file
  systems in Docker Compose; CI with quality, unit (Node 24 + 26), integration, build, Docker
  smoke-test and audit jobs; tag-triggered release workflow publishing images to GHCR;
  `pnpm release:version`.

### Security

- Security headers (helmet, CSP) for API and web, CORS allowlist, Origin and Host checks, rate
  limits, a limit on concurrent chats, upload hardening and delimiter neutralisation against
  prompt-injection attempts. RAGLab has **no authentication** – see
  [docs/security.md](docs/security.md) and [SECURITY.md](SECURITY.md).

[Unreleased]: https://github.com/krocon/rag-lab/commits/main
