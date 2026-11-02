# RAGLab

**An open-source RAG workbench for developers.**

RAGLab is a self-hosted workbench to build knowledge bases from your own documents, index them,
search them semantically and query them through a chat that cites its sources. Unlike a generic
chat client, RAGLab makes the retrieval pipeline transparent: documents, chunks, embeddings,
retrieval hits and scores are meant to be inspectable and debuggable.

> **Status: early foundation (v0.1.0).** The monorepo, database, API skeleton and web app shell
> work and are tested. The RAG pipeline itself (upload, chunking, embeddings, retrieval, chat) is
> **not implemented yet** – see [Roadmap](#roadmap).

## Principles

- **Local-first & self-hostable** – runs with Docker Compose; documents and vectors stay in your PostgreSQL.
- **Provider-neutral** – embedding and chat providers sit behind interfaces; Ollama is the first one.
- **Traceable answers** – answers must reference chunks that were actually retrieved, by stable IDs.
- **Transparent retrieval** – distances, scores and chunks are visible in the UI.
- **Security by design** – document content is untrusted input; prompt-injection risks are documented, not denied.

## Features

| Feature                                                                       | Status                |
| ----------------------------------------------------------------------------- | --------------------- |
| Monorepo (pnpm workspaces), strict TypeScript, ESLint, Prettier, Vitest       | ✅ available          |
| PostgreSQL 18 + pgvector via Docker Compose, SQL migrations                   | ✅ available          |
| API: liveness/readiness health checks, configuration info, OpenAPI docs       | ✅ available          |
| Web app: navigation, live system status, read-only settings, light/dark theme | ✅ available          |
| Docker images for API and web, GitHub Actions CI                              | ✅ available          |
| Knowledge bases, Markdown/TXT upload, chunking                                | ⏳ planned            |
| Embeddings via Ollama, vector retrieval with pgvector                         | ⏳ planned            |
| Chat with streamed answers and source references                              | ⏳ planned            |
| Retrieval playground (hits, scores, chunk preview)                            | ⏳ planned            |
| MCP server for external AI clients                                            | ⏳ planned (post-MVP) |

## Architecture

```text
apps/web (Angular 22) ──REST/SSE──▶ apps/api (Fastify 5) ──SQL──▶ PostgreSQL 18 + pgvector
                                          └──HTTP──▶ Ollama (embeddings, chat)
```

- [docs/architecture.md](docs/architecture.md) – system context, modules, data flow, error handling, security
- [docs/data-model.md](docs/data-model.md) – collections, documents, chunks, embeddings
- [docs/adr/](docs/adr/) – architecture decision records (technology stack, RAG pipeline)

Repository layout:

```text
apps/api/          Fastify API (TypeScript, Drizzle ORM, SQL migrations in apps/api/drizzle)
apps/web/          Angular app (standalone components, signals, zoneless)
packages/shared/   Type-only API contracts shared by api and web
infra/docker/      Dockerfiles and nginx config
docs/              Architecture, data model, ADRs
prompts/           Numbered work prompts that drive further development
```

## Quick start

Prerequisites: **Node.js ≥ 24.15** (26 LTS recommended), **pnpm** (any version ≥ 10 – the pinned
version from `package.json` is used automatically), **Docker** with Compose.

```bash
git clone https://github.com/krocon/rag-lab.git
cd rag-lab
cp .env.example .env        # adjust if needed – never commit .env
pnpm install
pnpm db:up                  # PostgreSQL + pgvector on 127.0.0.1:5432
pnpm db:migrate             # applies SQL migrations
pnpm dev                    # API on :3000, web app on :4200
```

Open <http://localhost:4200>. The start page shows the live status of API, database and pgvector.
API docs (OpenAPI): <http://localhost:3000/api/docs>.

If port 5432 is taken, change `POSTGRES_PORT` **and** the port in `DATABASE_URL` in `.env`.

### Everything in containers

```bash
docker compose --profile app up -d --build
```

Web app: <http://localhost:8080> (nginx proxies `/api` to the API container; migrations run on API start).

### AI providers (Ollama)

Embeddings and chat will use [Ollama](https://ollama.com). On macOS, run Ollama natively (containers
have no GPU access under Docker Desktop). RAGLab never downloads models for you – pull the models
configured in `.env` yourself, e.g.:

```bash
ollama pull nomic-embed-text
```

`EMBEDDING_DIMENSIONS` must match the model's output dimension (768 for `nomic-embed-text`) and the
database vector column. On Linux you can use `docker compose --profile ollama up -d` instead.

## Development

| Command                                           | What it does                                    |
| ------------------------------------------------- | ----------------------------------------------- |
| `pnpm dev`                                        | API (watch mode) and web dev server in parallel |
| `pnpm test`                                       | Unit tests (API and web)                        |
| `pnpm test:integration`                           | API integration tests – needs `pnpm db:up`      |
| `pnpm lint` / `pnpm typecheck`                    | ESLint / TypeScript across all packages         |
| `pnpm format` / `pnpm format:check`               | Prettier                                        |
| `pnpm build`                                      | Production builds                               |
| `pnpm db:up` / `pnpm db:down` / `pnpm db:migrate` | Database container and migrations               |

Configuration is read from environment variables (validated at startup); see
[.env.example](.env.example) for every option.

## Roadmap

Development is driven by numbered prompts in [prompts/](prompts/README.md): domain model →
ingestion → chunking → embeddings → retrieval → chat streaming → knowledge-base UI → chat UI →
retrieval playground → hardening → evaluation → MCP server → release → docs & demo.

## Security

RAGLab is designed for local use: it has no authentication yet and must not be exposed to the
internet. Imported documents can contain prompt-injection attempts; RAGLab separates them from
instructions but cannot fully prevent manipulated answers – always check the cited sources.
See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Contributing

Contributions are welcome – see [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © 2026 Marc Kronberg
