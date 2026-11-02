# Contributing to RAGLab

Thanks for your interest in RAGLab! This document explains how to set up the project, how it is
tested and what we expect from a pull request.

## Setup

Prerequisites: Node.js ≥ 24.15 (26 LTS recommended), pnpm (the version pinned in `package.json` is
used automatically), Docker with Compose. Ollama is only needed to try the app with real models –
the test suites never call a model.

```bash
git clone https://github.com/krocon/rag-lab.git
cd rag-lab
cp .env.example .env
pnpm install
pnpm db:up && pnpm db:migrate   # PostgreSQL 18 + pgvector on 127.0.0.1:5432
pnpm dev                        # API on :3000 (watch mode), web app on :4200
pnpm demo:seed                  # optional: demo knowledge base (needs the embedding model in Ollama)
```

More in the [Quick start](README.md#quick-start).

## Commands

| Command                                 | Use it when                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `pnpm format` / `pnpm format:check`     | Always (Prettier, including Markdown)                                       |
| `pnpm lint` / `pnpm typecheck`          | Always                                                                      |
| `pnpm test`                             | Always – unit tests of API, web app, MCP server and `scripts/`              |
| `pnpm build`                            | Always                                                                      |
| `pnpm test:integration`                 | You touched the API or the database (needs `pnpm db:up`)                    |
| `pnpm eval --baseline`                  | You touched ingestion, chunking, embeddings or retrieval                    |
| `pnpm docs:links`                       | You touched Markdown files (relative links and anchors)                     |
| `pnpm docker:smoke`                     | You touched `infra/docker`, `docker-compose.yml` or the build               |
| `pnpm --filter <package> test <filter>` | Run matching test files only, e.g. `pnpm --filter @raglab/api test chunker` |

## Test strategy

- **Unit tests** (`pnpm test`, Vitest; `node --test` for `scripts/`) are deterministic: no
  database, no Ollama, no network. Providers are replaced by fakes (fake `fetch`, fake HTTP
  servers); HTTP routes are tested with `app.inject()`.
- **Integration tests** (`apps/api/test/integration/*.int.test.ts`) run against PostgreSQL with
  pgvector in a separate test database (`TEST_DATABASE_URL`, or `<DATABASE_URL name>_test`, created
  automatically and emptied before every test). Your development data is never touched.
- **Evaluation** (`pnpm eval`) measures retrieval quality with your Ollama embedding model;
  `pnpm eval --baseline` uses a deterministic lexical baseline and runs in CI as a smoke test. When
  you change chunking or retrieval, compare the results before and after (see
  [eval/README.md](eval/README.md)) and mention them in the pull request.
- **Live test** (`RAGLAB_LIVE_TESTS=1 pnpm --filter @raglab/api test:live`) talks to a real Ollama;
  it is optional and not part of CI.
- Fix failing tests – never disable or weaken a test to get green.

## What CI expects

Every pull request runs `.github/workflows/ci.yml`; all jobs must be green before merging:

| Job           | Checks                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------- |
| `quality`     | `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm docs:links`                    |
| `test`        | `pnpm test` on Node 24 **and** 26 (use APIs available in both)                           |
| `integration` | PostgreSQL + pgvector service, `pnpm db:migrate`, `pnpm test:integration`, eval baseline |
| `build`       | `pnpm build`                                                                             |
| `docker`      | Builds all images (never pushed) and runs `scripts/docker-smoke.mjs` against the stack   |
| `audit`       | `pnpm audit --prod --audit-level=high`                                                   |

A new push to a pull request cancels the previous run. Workflows use least-privilege permissions
and actions pinned to major versions of their official publishers; keep it that way when you
change them. Versions and releases are handled by the maintainer
([docs/release.md](docs/release.md), German).

## Conventions

The binding project rules – architecture, API conventions, database, tests, security and the
Definition of Done – are written down (in German) in
[prompts/done/002-project-bootstrap.md](prompts/done/002-project-bootstrap.md). The essentials:

- **Respect the architecture.** Read [docs/architecture.md](docs/architecture.md) and the
  [ADRs](docs/adr/). API modules live in `apps/api/src/modules/<name>/` (`*.routes.ts`,
  `*.service.ts`, `*.repository.ts`), are wired with factory functions (no DI container) and use
  each other only through exported service functions. Significant decisions get a new ADR
  (`docs/adr/NNNN-title.md`).
- **API:** everything under `/api`, camelCase JSON, JSON schemas for every route (they feed the
  OpenAPI document), the error format `{ error: { code, message, details? } }`. Never confuse
  `distance` (cosine distance) and `score` (`1 − distance`).
- **Provider neutrality.** No business logic may depend directly on a specific LLM or embedding
  provider; model names, dimensions, URLs and limits come from configuration
  (`apps/api/src/config/env.ts`). New variables go into `.env.example` with a safe example value.
- **Database changes** go through migrations in `apps/api/drizzle` (generated with
  `pnpm --filter @raglab/api db:generate`, reviewed before commit, never edited once applied).
  Update [docs/data-model.md](docs/data-model.md).
- **Shared package** (`packages/shared`) contains types only – use `import type`.
- **MCP server** (`apps/mcp`) only talks to the HTTP API and offers read-only tools; it must never
  write to stdout (protocol channel) – log via `src/logger.ts` (stderr). See
  [ADR 0003](docs/adr/0003-mcp-server.md).
- **Untrusted content:** documents, uploads, user input and model output are untrusted. Render
  them as text only; never weaken the prompt-injection measures without a security review
  ([docs/security.md](docs/security.md)).
- **No secrets** in code, tests, fixtures or commits. Use `.env` (git-ignored).
- **No placeholders presented as features.** Unfinished functionality is marked as planned in UI
  and docs.
- **Accessibility:** keyboard operable, visible focus, semantic HTML, sufficient contrast, status
  never conveyed by color alone.
- **Test data and examples** (eval dataset, demo knowledge base) must be self-written – no copied
  texts, no real people or companies.

### Language

Code, API, commit messages and public repository files (README, CONTRIBUTING, SECURITY,
CHANGELOG, demo data) are written in English. Architecture docs (`docs/`) and work prompts
(`prompts/`) are written in German.

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/), e.g.
`feat(api): add collections endpoint`, `fix(web): announce upload errors`,
`docs: update data model`.

## Pull request checklist

- [ ] One concern per pull request; the description says what changed and why.
- [ ] Tests for new behaviour (unit; integration where database or HTTP behaviour matters).
- [ ] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass locally.
- [ ] `pnpm test:integration` passes if the API or database changed.
- [ ] `pnpm eval --baseline` before/after compared if ingestion, chunking or retrieval changed.
- [ ] Docs updated where behaviour changed: `README.md`, `docs/architecture.md` (module table and
      §9 "Implementierungsstand"), `docs/data-model.md`, `.env.example`; `pnpm docs:links` passes.
- [ ] User-facing changes have an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
- [ ] Screenshots in `docs/images/` still match the UI if you changed it
      ([how they are made](docs/demo/screenshots.md)).
- [ ] No secrets, no real personal data, no copied third-party texts.

## Reporting issues

Please include steps to reproduce, expected and actual behaviour, and your environment (OS, Node,
pnpm, Docker and Ollama versions, models). Security issues: see [SECURITY.md](SECURITY.md) – do
not open public issues.
