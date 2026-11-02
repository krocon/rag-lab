# Contributing to RAGLab

Thanks for your interest in RAGLab! This document explains how to set up the project and what we
expect from contributions.

## Setup

Follow the [Quick start](README.md#quick-start). Before opening a pull request, run:

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm db:up && pnpm test:integration   # if you touched the API or database
```

CI runs the same checks (see `.github/workflows/ci.yml`).

## Guidelines

- **Small, focused pull requests.** One concern per PR; describe what and why.
- **Tests are part of the change.** New behaviour needs unit tests; database or HTTP behaviour
  needs integration tests where it matters.
- **No placeholders presented as features.** Unfinished functionality must be clearly marked as
  planned in UI and docs.
- **Respect the architecture.** Read [docs/architecture.md](docs/architecture.md) and the
  [ADRs](docs/adr/). Significant decisions get a new ADR (`docs/adr/NNNN-title.md`).
- **Provider neutrality.** No business logic may depend directly on a specific LLM or embedding
  provider; model names and dimensions come from configuration.
- **Database changes** go through migrations in `apps/api/drizzle` (generated with
  `pnpm --filter @raglab/api db:generate`, reviewed before commit). Update `docs/data-model.md`.
- **Shared package** (`packages/shared`) contains types only – use `import type`.
- **No secrets** in code, tests, fixtures or commits. Use `.env` (git-ignored).
- **Accessibility:** keyboard operable, visible focus, semantic HTML, sufficient contrast, status
  never conveyed by color alone.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/), e.g. `feat(api): add collections endpoint`,
`fix(web): announce upload errors`, `docs: update data model`.

## Language

Code, API, commit messages and public repository files are written in English. Architecture docs
(`docs/`) and work prompts (`prompts/`) are currently written in German.

## Reporting issues

Please include steps to reproduce, expected and actual behaviour, and your environment (OS, Node,
pnpm, Docker versions). Security issues: see [SECURITY.md](SECURITY.md) – do not open public issues.
