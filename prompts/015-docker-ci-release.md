# 015 – Docker, CI & Release-Vorbereitung

## Kontext

RAGLab ist eine self-hosted RAG-Workbench (pnpm-Monorepo: `apps/api` Fastify, `apps/web` Angular,
ggf. `apps/mcp`, `packages/shared` type-only; PostgreSQL 18 + pgvector per Docker Compose; Ollama
nativ auf dem Host). Seit 001 existieren `docker-compose.yml` (Postgres standardmäßig, Profile `app`
für API + Web und `ollama`), Dockerfiles unter `infra/docker/` und ein CI-Workflow
`.github/workflows/ci.yml`. Nach 003–014 ist der Funktionsumfang gewachsen; Container, CI und
Versionierung müssen das abbilden und produktionsnah werden.

**Voraussetzungen:** 002–012 erledigt (013/014 empfohlen – deren Tests/Apps einbeziehen, falls vorhanden).

## Zuerst untersuchen

- `docker-compose.yml`, `infra/docker/api.Dockerfile`, `infra/docker/web.Dockerfile`, ggf. nginx-
  Konfiguration, `.dockerignore`, `.github/workflows/ci.yml`, Root-`package.json` (Skripte,
  `packageManager`, `engines`), `pnpm-workspace.yaml` (`allowBuilds`, `minimumReleaseAge`).
- ADR 0001 (Node 26 LTS für Docker/CI, CI zusätzlich Node 24; pnpm-Version), `docs/architecture.md` §6.
- Wie Migrationen aktuell im Container laufen (oder nicht) und ob die API `drizzle/` im Image braucht.
- Ergebnisse aus 012 (Security-Header für Web, `API_DOCS_ENABLED`, Rate Limits).
Teste jede Änderung tatsächlich (`docker compose … up --build`); Docker ist auf dem Mac verfügbar.

## Ziele

**Docker**
1. Multi-Stage-Builds mit gepinnten Base-Images (Node 26 LTS slim, Version per Tag prüfen; optional
   Digest), `pnpm deploy --prod` bzw. `--filter` für schlanke Runtime-Images, **non-root**-User,
   `NODE_ENV=production`, keine Dev-Dependencies, kein Quellcode außer Build-Ergebnis, `.dockerignore`
   vollständig (`.env`, `node_modules`, `.git`, `eval/results`).
2. Migrationen: eigener Compose-Service `migrate` (läuft einmal, `depends_on` Postgres healthy; API
   wartet per `service_completed_successfully`) **oder** begründete Alternative.
3. Web-Image: statische Auslieferung (z. B. `nginxinc/nginx-unprivileged`), SPA-Fallback,
   Reverse-Proxy `/api` → API inkl. SSE (Pufferung aus: `proxy_buffering off`, passende Timeouts),
   Security-Header/CSP (aus 012), Gzip/Cache-Header für gehashte Assets.
4. Health Checks für alle Services, `restart`-Policies, Ressourcen-Hinweise, Ports nur an `127.0.0.1`.
5. Optional `apps/mcp`-Image, falls 014 erledigt (sonst dokumentieren).
6. Ein Kommando für den kompletten Stack: `docker compose --profile app up -d --build` → UI unter
   `http://localhost:8080` nutzbar (Ollama nativ via `host.docker.internal`).

**CI** (`.github/workflows/ci.yml`)
7. Jobs: `quality` (format:check, lint, typecheck), `test` (Matrix Node 24 + 26), `integration`
   (Service-Container `pgvector/pgvector:0.8.7-pg18-trixie`, Migrationen, `pnpm test:integration`,
   Eval-Smoke-Test aus 013), `build` (alle Pakete), `docker` (Images bauen, nicht pushen;
   optional Smoke-Test: Stack starten, `/api/health/ready` prüfen), `audit` (`pnpm audit --prod`).
8. pnpm-Store-Caching, `concurrency` mit `cancel-in-progress` für PRs, minimale `permissions`
   (`contents: read`), Actions auf Major-Tags oder SHAs gepinnt (Entscheidung dokumentieren),
   `timeout-minutes` pro Job.
9. Dependabot-Konfiguration (`.github/dependabot.yml`) für npm, GitHub Actions, Docker – falls nicht in
   012 erledigt.

**Versionierung & Release**
10. SemVer, gemeinsame Version für alle Pakete (Root + Workspaces) und `API_VERSION`-Quelle
    (`apps/api/src/version.ts`) konsistent; Entscheidung „Changesets vs. manuell + Skript“ treffen und
    begründen (Empfehlung für den Umfang: einfaches Skript `pnpm release:version <x.y.z>` + CHANGELOG).
11. `CHANGELOG.md` (Englisch, Keep a Changelog) mit einem Eintrag für den aktuellen Stand.
12. Release-Workflow `.github/workflows/release.yml` (Trigger: Tag `v*.*.*`): Checks wiederholen,
    Images bauen, nach GHCR pushen (`ghcr.io/<owner>/raglab-api|web`, Owner aus `github.repository_owner`,
    **keine** erfundenen URLs), GitHub-Release mit Changelog-Auszug. Permissions minimal
    (`packages: write`, `contents: write` nur hier).
13. `docs/release.md` (Deutsch): Release-Checkliste.

## Nicht im Umfang

- Tags pushen, Releases erstellen oder Images veröffentlichen – das macht der Maintainer.
- Kubernetes/Helm, Cloud-Deployments, TLS-Terminierung (nur Hinweis auf Reverse-Proxy).
- Signierte Images/SBOM/Provenance (als Ausblick dokumentieren; optional, falls trivial mit
  `docker/build-push-action`).
- Ollama-Modelle in Images einbacken.

## Akzeptanzkriterien

- [ ] `docker compose --profile app up -d --build` startet Postgres, Migration, API, Web; alle Health
      Checks `healthy`; Upload → Chat funktioniert über `http://localhost:8080` (mit Ollama).
- [ ] Container laufen als non-root; Runtime-Images enthalten keine Dev-Dependencies und keine `.env`.
- [ ] SSE funktioniert durch den Web-Proxy ohne Pufferung.
- [ ] CI-Workflow ist syntaktisch gültig (z. B. `actionlint`, falls verfügbar) und deckt alle Jobs ab;
      lokal nachgestellte Schritte laufen grün.
- [ ] Versionen konsistent; Release-Skript getestet (Dry-Run); CHANGELOG vorhanden.
- [ ] Release-Workflow pusht nur bei Tags, nie bei PRs; keine Secrets im Repo.
- [ ] Image-Größen im Bericht genannt (vorher/nachher).

## Tests

- Unit-Test für das Versions-Skript (falls Skript-Logik vorhanden).
- Manuelle/automatisierte Docker-Smoke-Tests: `docker compose config`, Build aller Images,
  Stack-Start, `curl` auf `/api/health/ready` und `/` (Web), SSE-Test durch den Proxy (`curl -N`).
- Bestehende Suite unverändert grün.

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build && pnpm format:check
docker compose config -q && docker compose --profile app up -d --build && docker compose ps
```

## Dokumentation & Abschluss

- README (Quick Start mit Docker, Upgrade-Hinweise), `docs/architecture.md` §6 + §9, ADR 0001 bei
  Versionsänderungen, `docs/release.md`, CONTRIBUTING (CI-Erwartungen), `.env.example`.
- Abschlussbericht gemäß 002; Datei nach `prompts/done/`. Nächster Prompt: `016-documentation-and-demo.md`.
