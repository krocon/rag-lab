# RAGLab – Release-Prozess

Stand: Prompt 015. Dieses Dokument beschreibt Versionierung, Container-Images, CI und die
Release-Checkliste. Die Ausführung (Tag pushen, Release veröffentlichen) liegt beim Maintainer.

## 1. Versionierung

- **SemVer 2.0.0**, eine **gemeinsame Version** für alle Pakete: Root-`package.json`,
  `apps/api`, `apps/web`, `apps/mcp`, `packages/shared`. Vor 1.0.0 können Minor-Versionen
  inkompatible Änderungen enthalten (SemVer §4); sie stehen dann im CHANGELOG unter `Changed`.
- **Einzige Quelle** ist `version` in den `package.json`-Dateien. Die API liest sie zur Laufzeit
  (`apps/api/src/version.ts` → `GET /api/health`, OpenAPI `info.version`), ebenso der MCP-Server
  (`apps/mcp/src/server.ts`, `serverInfo.version`). Es gibt keine weitere Stelle zum Anpassen.
- **Changelog:** [`CHANGELOG.md`](../CHANGELOG.md) (Englisch, Keep a Changelog 1.1.0). Jede
  nutzerrelevante Änderung wird im selben Pull Request unter `## [Unreleased]` eingetragen.
- **Tags:** `vX.Y.Z` bzw. `vX.Y.Z-rc.N` für Vorabversionen.

### Entscheidung: Skript statt Changesets

`pnpm release:version <x.y.z>` (`scripts/release-version.mjs`) statt
[Changesets](https://github.com/changesets/changesets):

- Alle Pakete sind `private` und werden nie nach npm veröffentlicht; ausgeliefert werden
  Container-Images. Changesets' Stärken (unabhängige Paketversionen, npm-Publish, Changeset-Dateien
  je PR, Release-PR-Bot) bringen hier keinen Nutzen.
- Eine gemeinsame Version und ein handgepflegtes CHANGELOG sind für ein Projekt dieser Größe
  einfacher zu verstehen und zu prüfen; keine zusätzliche Abhängigkeit (Supply Chain).
- Das Skript ist klein, ohne Abhängigkeiten und unit-getestet
  (`scripts/release/version-lib.test.mjs`, läuft in `pnpm test`).
- Neubewertung, wenn Pakete einzeln veröffentlicht werden (z. B. `@raglab/mcp` auf npm).

Das Skript

1. prüft die Version (SemVer, nicht kleiner als die aktuelle; gleich ist erlaubt, damit die erste
   Veröffentlichung die bestehende `0.1.0` verwenden kann) und dass alle Pakete dieselbe Version
   haben,
2. setzt `version` in allen `package.json` (Formatierung bleibt erhalten),
3. verschiebt den Inhalt von `## [Unreleased]` in `## [x.y.z] - YYYY-MM-DD`, legt einen leeren
   `Unreleased`-Abschnitt an und aktualisiert die Vergleichslinks am Dateiende,
4. bricht ab, wenn `Unreleased` leer ist oder die Version schon einen Abschnitt hat.

```bash
pnpm release:version 0.2.0 --dry-run   # zeigt Änderungen und Release Notes, schreibt nichts
pnpm release:version 0.2.0             # schreibt package.json-Dateien und CHANGELOG.md
node scripts/release-version.mjs --check 0.2.0   # Konsistenzprüfung (Release-Workflow)
node scripts/release-version.mjs --notes 0.2.0   # Release Notes aus dem CHANGELOG
```

## 2. Container-Images

| Image        | Dockerfile                    | Basis (gepinnt)                             | Benutzer      | Inhalt                                                 |
| ------------ | ----------------------------- | ------------------------------------------- | ------------- | ------------------------------------------------------ |
| `raglab-api` | `infra/docker/api.Dockerfile` | `node:26.13.0-trixie-slim`                  | `node` (1000) | `dist/`, `drizzle/` (SQL), Produktions-`node_modules`  |
| `raglab-web` | `infra/docker/web.Dockerfile` | `nginxinc/nginx-unprivileged:1.30.6-alpine` | `nginx` (101) | Angular-Build, `nginx.conf`, Security-Header-Snippet   |
| `raglab-mcp` | `infra/docker/mcp.Dockerfile` | `node:26.13.0-trixie-slim`                  | `node` (1000) | `dist/`, Produktions-`node_modules` (stdio, kein Port) |

- Multi-Stage: Build-Stage mit pnpm (`--frozen-lockfile`, BuildKit-Cache für den pnpm-Store),
  Runtime-Stage nur mit Build-Ergebnis und `pnpm deploy --prod` (keine Dev-Abhängigkeiten, kein
  Quellcode, kein npm/npx). `.dockerignore` schließt `.env`, `node_modules`, `.git`, `dist`,
  `eval/results`, `docs`, `prompts` aus.
- Dateien gehören `root` und sind für den Laufzeitbenutzer nur lesbar; Compose startet zusätzlich
  mit read-only Root-Dateisystem, `cap_drop: ALL` und `no-new-privileges`.
- Basis-Images stehen mit exaktem Tag in jeder `FROM`-Zeile, damit Dependabot sie aktualisieren
  kann. Digests sind bewusst nicht gepinnt (Lesbarkeit; Dependabot-Updates als PR genügen für den
  Umfang) – Ausblick siehe §7.
- Die Web-Build-Stage läuft auf der Plattform des Build-Hosts (`--platform=$BUILDPLATFORM`), weil
  ihr Ergebnis plattformunabhängig ist; API und MCP bauen je Zielplattform (amd64, arm64).

**Image-Größen** (lokal, linux/arm64, `docker image inspect … .Size`, unkomprimiert):

| Image        | vorher (Stand 014)       | nachher (015)          | Anmerkung                                                                                                                                         |
| ------------ | ------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `raglab-api` | 435 MB (`bookworm-slim`) | 445 MB (`trixie-slim`) | Basis-Image allein 375 MB (bookworm: 371 MB); `node_modules` 61 MB, `dist` 1,2 MB. npm ist entfernt, belegt aber weiter Platz in der Basisschicht |
| `raglab-web` | 91 MB                    | 91 MB                  | nginx-unprivileged 1.30.6 (vorher 1.30-alpine, ungepinnt)                                                                                         |
| `raglab-mcp` | –                        | 410 MB                 | neu; `node_modules` des MCP-SDK inkl. HTTP-Transporte                                                                                             |

Die Images waren bereits Multi-Stage mit `deploy --prod`; der Größengewinn ist daher klein. Den
Ausschlag gibt das Node-Basis-Image (≈ 150 MB `node`-Binary + Debian). Eine deutliche Verkleinerung
(≈ –90 MB) wäre nur mit eigenem Basis-Image (Debian slim + kopiertes `node`-Binary) oder Distroless
möglich – bewusst nicht umgesetzt, weil der Prompt das offizielle Node-26-slim-Image vorgibt und
Sicherheitsupdates so direkt über Dependabot kommen.

## 3. Docker Compose (kompletter Stack)

```bash
cp .env.example .env                       # einmalig, Passwort ändern
docker compose --profile app up -d --build # postgres → migrate → api → web
docker compose ps                          # alle healthy, migrate "exited (0)"
open http://localhost:8080
```

- **Migrationen:** eigener Service `migrate` (gleiches Image wie die API, Kommando
  `node dist/db/migrate.js`), läuft nach `postgres: service_healthy` einmal; die API startet erst
  bei `service_completed_successfully`. Die API wendet selbst keine Migrationen mehr an – wer das
  API-Image ohne Compose betreibt, startet es vorher einmal mit `node dist/db/migrate.js`.
- **Health Checks:** postgres (`pg_isready`), api (`/api/health`, Liveness), web (`/healthz`, ohne
  API-Abhängigkeit), ollama (`ollama list`); `migrate` hat keinen (einmaliger Lauf). Readiness inkl.
  Datenbank und Vektordimension: `GET /api/health/ready`.
- **Restart-Policies:** `unless-stopped` für postgres/api/web/ollama, `no` für migrate.
- **Ressourcen-Limits** (Startwerte für einen Nutzer): api 1 GiB (Uploads werden im Speicher
  geprüft), web 128 MiB, migrate/mcp 256 MiB; PostgreSQL ohne Limit (HNSW-Aufbau braucht Speicher).
- **Ports** nur auf `127.0.0.1` (8080 Web, 3000 API, 5432 PostgreSQL, 11434 Ollama-Profil).
- **nginx:** SPA-Fallback, `/api` → `api:3000` mit `proxy_buffering off` (SSE), 300 s
  Lese-/Sende-Timeout, Uploads ungepuffert bis 101 MiB, gzip (nicht für `text/event-stream`),
  `Cache-Control: immutable` für gehashte Assets und `no-cache` für `index.html`, Security-Header
  (security.md §5) auf allen App-Antworten.
- **Release-Images statt lokaler Builds:** `RAGLAB_API_IMAGE`, `RAGLAB_WEB_IMAGE`,
  `RAGLAB_MCP_IMAGE` (siehe `.env.example`), dann `docker compose --profile app up -d --no-build`.
- **MCP im Container:** `docker compose --profile mcp run --rm -T mcp` (stdio) erreicht die API über
  das interne Netz (`RAGLAB_API_URL=http://api:3000`; deshalb steht `api` in `ALLOWED_HOSTS` des
  API-Containers). Der MCP-Server warnt beim Start, dass `api` kein lokaler Host ist – im privaten
  Compose-Netz ist das erwartbar.
- **Upgrade:** `git pull` (bzw. neue Image-Tags), `docker compose --profile app up -d --build`;
  `migrate` wendet neue Migrationen automatisch an. Vorher ein Backup ziehen:
  `docker compose exec postgres pg_dump -U raglab raglab > backup.sql`.

**Smoke-Test:** `pnpm docker:smoke` (`scripts/docker-smoke.mjs`) baut die Images, startet den
Stack mit einem Fake-Ollama (`scripts/docker-smoke/fake-ollama.mjs`), prüft Health, Header, gzip,
SPA-Fallback, non-root, Image-Inhalt (keine Dev-Abhängigkeiten, kein npm, keine `.env`),
read-only-Dateisystem, Upload → Indexierung → Chat mit **ungepuffertem SSE durch nginx** (erstes
Token ≥ 1,2 s vor `done`) und den MCP-Server über stdio. Danach entfernt er die Container
`migrate`/`api`/`web`; `postgres` und das Volume bleiben (`--keep` lässt alles laufen,
`--no-build` nutzt vorhandene Images). Er legt eine Collection `docker-smoke-…` in der
konfigurierten Datenbank an und löscht sie wieder.

## 4. CI (`.github/workflows/ci.yml`)

| Job           | Inhalt                                                                               | Timeout |
| ------------- | ------------------------------------------------------------------------------------ | ------- |
| `quality`     | `format:check`, `lint`, `typecheck`, `docs:links` (Node 26)                          | 15 min  |
| `test`        | `pnpm test` – Matrix Node 24 und 26 (API, Web, MCP, `scripts/`)                      | 20 min  |
| `integration` | Service-Container pgvector, `db:migrate`, `test:integration`, `pnpm eval --baseline` | 20 min  |
| `build`       | `pnpm build` (alle Pakete)                                                           | 15 min  |
| `docker`      | `docker compose config`, Build aller Images (kein Push), `scripts/docker-smoke.mjs`  | 30 min  |
| `audit`       | `pnpm audit --prod --audit-level=high` (security.md §8)                              | 10 min  |

- pnpm-Store-Cache über `actions/setup-node` (`cache: pnpm`, Schlüssel `pnpm-lock.yaml`).
- `concurrency`: ein Lauf je PR/Branch; `cancel-in-progress` nur für Pull Requests, nie für `main`
  oder Releases.
- `permissions: contents: read` für alle Jobs.
- Der Workflow ist zusätzlich per `workflow_call` aufrufbar; der Release-Workflow nutzt ihn als
  erste Stufe, damit dieselben Prüfungen laufen.

### Entscheidung: Actions auf Major-Tags

Alle Actions stammen von den offiziellen Herausgebern (`actions/*`, `pnpm/action-setup`,
`docker/*`) und sind auf Major-Tags gepinnt (z. B. `actions/checkout@v7`, Stand 2026-11-02 per
`git ls-remote --tags` geprüft). Begründung: lesbar, Sicherheits- und Bugfix-Updates innerhalb der
Major-Version kommen automatisch, Dependabot schlägt Major-Wechsel vor. Restrisiko: ein
kompromittierter Tag eines dieser Herausgeber. Wer das ausschließen will, pinnt auf Commit-SHAs
(`uses: actions/checkout@<sha> # v7.x.y`); Dependabot aktualisiert auch diese Form.

## 5. Release-Workflow (`.github/workflows/release.yml`)

Trigger: **nur** Push eines Tags `v*.*.*` – nie Pull Requests oder Branch-Pushes, kein manueller
Start (ein Release ohne Tag hätte keine eindeutige Version).

1. `verify`: Version aus dem Tag; `release-version.mjs --check` (alle `package.json` + CHANGELOG).
2. `ci`: der komplette CI-Workflow (`workflow_call`).
3. `images`: je Image Build für `linux/amd64` und `linux/arm64` (QEMU, Buildx, GHA-Cache) und Push
   nach `ghcr.io/<owner>/raglab-api|web|mcp` – `<owner>` ist `github.repository_owner` in
   Kleinbuchstaben. Tags `X.Y.Z` und `X.Y` (für Vorabversionen nur `X.Y.Z-…`) plus `latest` bei
   regulären Releases; OCI-Labels (Quelle, Revision, Version) über `docker/metadata-action`;
   Provenance (`mode=max`) und SBOM als Attestations.
4. `github-release`: GitHub-Release mit dem CHANGELOG-Abschnitt als Text (`gh release create
--verify-tag`), bei `-` im Tag als Pre-Release.

Berechtigungen: Standard `contents: read`; nur `images` erhält `packages: write`, nur
`github-release` `contents: write`. Es wird ausschließlich das automatische `GITHUB_TOKEN`
verwendet, keine weiteren Secrets.

## 6. Checkliste für ein Release

**Einmalig vor dem ersten Release (Repository-Einstellungen, Maintainer):**

- [ ] Settings → Actions → General: Actions erlaubt; „Workflow permissions“ darf auf „Read
      repository contents“ stehen (die Workflows fordern mehr explizit an).
- [ ] Settings → Code security: Dependabot version updates (und security updates) aktivieren.
- [ ] Branch protection für `main`: Status-Checks `Format, lint, typecheck`, `Unit tests (Node 24)`,
      `Unit tests (Node 26)`, `Integration tests …`, `Build all packages`,
      `Docker images + stack smoke test`, `Dependency audit (production)` als erforderlich.
- [ ] Optional: Tag-Schutzregel (Rulesets) für `v*`, damit nur Maintainer Release-Tags pushen.
- [ ] Nach dem ersten Release: Pakete `raglab-api`, `raglab-web`, `raglab-mcp` unter
      github.com → Packages auf **public** stellen (GHCR legt sie privat an) und mit dem Repository
      verknüpfen (passiert über das OCI-Label `org.opencontainers.image.source` meist automatisch).

**Für jedes Release:**

1. [ ] `main` ist grün (CI), lokal aktuell: `git switch main && git pull`.
2. [ ] `CHANGELOG.md` → `## [Unreleased]` vollständig und verständlich (Englisch).
3. [ ] Lokal prüfen:
       `pnpm install --frozen-lockfile && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build`,
       `pnpm db:up && pnpm test:integration`, `pnpm docker:smoke`.
4. [ ] `pnpm release:version X.Y.Z --dry-run`, dann `pnpm release:version X.Y.Z`.
5. [ ] Diff prüfen, `pnpm format:check`, Commit `chore(release): vX.Y.Z` (per PR oder direkt nach
       Absprache).
6. [ ] Tag setzen und pushen: `git tag -a vX.Y.Z -m "RAGLab vX.Y.Z" && git push origin vX.Y.Z`.
7. [ ] Release-Workflow beobachten (Actions → Release); bei Fehlern Tag löschen
       (`git push --delete origin vX.Y.Z`), Ursache beheben, neu taggen.
8. [ ] Ergebnis prüfen: GitHub-Release mit Notes; Images `ghcr.io/<owner>/raglab-*:X.Y.Z` für
       amd64/arm64 (`docker buildx imagetools inspect ghcr.io/<owner>/raglab-api:X.Y.Z`); Stack mit
       den Release-Images starten (§3) und `/api/health` zeigt `X.Y.Z`.
9. [ ] Erstes Release: einfach `pnpm release:version 0.1.0` (gleiche Version erlaubt).

## 7. Ausblick (nicht umgesetzt)

- **Signierte Images** (cosign keyless über GitHub OIDC, `id-token: write`) und
  `actions/attest-build-provenance`; aktuell nur BuildKit-Provenance und SBOM als Attestations.
- **Digest-Pinning** der Basis-Images und SHA-Pinning der Actions (§4).
- **Image-Scan** (z. B. Trivy/Grype) im `docker`-Job.
- **Kleinere API-/MCP-Images** über Distroless oder Debian slim + `node`-Binary (§2).
- **`TRUST_PROXY`** für die API: hinter nginx sieht das Rate Limiting aktuell die IP des
  Web-Containers, d. h. alle Browser-Clients teilen sich ein Kontingent (für den lokalen
  Einzelnutzer unkritisch; bei mehreren Nutzern über einen Proxy anpassen).
- Kubernetes/Helm, TLS-Terminierung: nicht im Umfang – vor einem öffentlichen Betrieb ist ein
  Reverse Proxy mit TLS und Authentifizierung Pflicht (security.md §7).
