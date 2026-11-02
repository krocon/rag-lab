# ADR 0001 – Technologie-Stack

- Status: akzeptiert
- Datum: 2026-11-02
- Grundlage: [docs/00-bestandsaufnahme.md](../00-bestandsaufnahme.md) (Versionsprüfung vom 2026-11-01)

## Kontext

RAGLab soll lokal, self-hosted und provider-neutral laufen, eine transparente RAG-Pipeline bieten
und für Contributors leicht verständlich sein. Der Initialprompt gibt Angular, Node.js/TypeScript,
PostgreSQL + pgvector, Docker Compose und pnpm Workspaces vor; offen waren API-Framework,
Datenbankzugriff, Test-Tooling und konkrete Versionen.

## Entscheidungen

| Bereich      | Entscheidung                                                                       | Version (gepinnt/Range)                                                          |
| ------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Laufzeit     | Node.js LTS                                                                        | `engines: ^24.15.0 \|\| >=26.0.0`; Docker/CI: Node 26 LTS, CI zusätzlich Node 24 |
| Paketmanager | pnpm Workspaces, **ohne** Nx/Turborepo                                             | `pnpm@11.28.9` über `packageManager`                                             |
| Sprache      | TypeScript strict (inkl. `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) | `~6.0.3` workspace-weit                                                          |
| Frontend     | Angular 22, Standalone Components, Signals, zoneless                               | `22.2.x`                                                                         |
| API          | **Fastify 5** + `@fastify/swagger`/`-ui` (OpenAPI 3.1 aus Routen-Schemas)          | `^5.12.7`                                                                        |
| Validierung  | **zod 4** für Konfiguration; JSON-Schema an Routen (Fastify/Ajv)                   | `^4.6.7`                                                                         |
| DB-Zugriff   | **Drizzle ORM** + drizzle-kit (SQL-Migrationen), Treiber `pg`                      | `0.45.x` / `0.31.x`                                                              |
| Datenbank    | PostgreSQL 18 + pgvector 0.8.7                                                     | Image `pgvector/pgvector:0.8.7-pg18-trixie`                                      |
| KI-Provider  | Ollama (nativ auf dem Host) per `fetch`, hinter eigenen Interfaces                 | –                                                                                |
| Tests        | Vitest (API und Web)                                                               | `^5.0.5`                                                                         |
| Qualität     | ESLint 10 (flat config) + typescript-eslint + angular-eslint, Prettier 3           |                                                                                  |
| Logging      | pino (in Fastify integriert)                                                       |                                                                                  |
| Lizenz       | **MIT** (bestehende `LICENSE`)                                                     |                                                                                  |

## Begründungen

**Fastify statt NestJS/Express/Hono.** Fastify liefert Schema-Validierung, OpenAPI-Generierung und
strukturiertes Logging ohne zusätzliche Schichten; SSE ist mit `reply.raw` bzw. einem Stream ohne
Zusatzframework möglich; `app.inject()` macht HTTP-Tests ohne offenen Port trivial. NestJS bringt
DI und Struktur, aber deutlich mehr Gewicht und Dekoratoren-Magie, die für einen MVP mit
überschaubarem Modulumfang keinen Vorteil bietet. Express hat kein eingebautes Schema/OpenAPI, Hono
ein weniger etabliertes OpenAPI-Ökosystem.

**Kein DI-Container.** Abhängigkeiten werden über Factory-Funktionen verdrahtet
(`buildApp({ config, probe })`). Das ist explizit, typsicher und testfreundlich. Ein Container wird
erst erwogen, wenn die Verdrahtung unübersichtlich wird.

**Drizzle statt Prisma/Kysely/rohem SQL.** Drizzle ist SQL-nah (Queries lesen sich wie SQL),
vollständig typisiert, erzeugt **lesbare SQL-Migrationen**, die eingecheckt werden, und hat einen
eingebauten `vector`-Spaltentyp sowie Helfer für `cosineDistance`. Prisma unterstützt `vector` nur
über `Unsupported(...)` und Raw-SQL; Kysely wäre eine gute Alternative, verlangt aber handgeschriebene
Migrationen ohne Schema-Diffing. drizzle-orm 1.0 ist noch RC → 0.45.x.

**pnpm ohne Nx/Turborepo.** Zwei Apps und ein Typ-Paket brauchen weder Task-Graph noch Remote-Cache;
`pnpm -r` und `--filter` reichen. Neubewertung, wenn Build-Zeiten in CI relevant werden.

**`packages/shared` nur mit Typen.** Laufzeitcode zwischen Browser und Node zu teilen erzwingt einen
Build-Schritt und Bundling-Fragen. Type-only-Exports (`import type`) verschwinden beim Kompilieren;
das Paket braucht daher keinen Build.

**TypeScript 6.0 statt 7.** Angular 22 verlangt `typescript >=6.0 <6.1`, typescript-eslint
unterstützt `<6.1`. Eine Version workspace-weit verhindert Drift.

**Vitest überall.** Angular 22 nutzt Vitest als Standard-Test-Runner; die API verwendet dasselbe
Werkzeug – eine Test-API, eine Konfigurationssyntax.

**Ollama nativ, nicht im Container.** Unter Docker Desktop auf macOS hat ein Container keinen
GPU-Zugriff. Compose enthält ein optionales Profil `ollama` für Linux. Modelle werden nie automatisch
heruntergeladen.

**Lizenz MIT statt Apache-2.0.** Das Repository enthielt bereits eine MIT-Lizenz (© 2026 Marc
Kronberg); der Maintainer hat entschieden, sie beizubehalten (Bestandsaufnahme, Abschnitt 5).

## Abweichungen von der Bestandsaufnahme

- **pnpm 11.28.9 statt 12.16.1.** pnpm 12 wird als nativer Binary verteilt. Die automatische
  Versionsumschaltung einer lokal installierten pnpm-10-CLI (`packageManager`-Feld) scheitert daran
  (`ENOEXEC`), pnpm 11 funktioniert ohne Systemänderung. Wechsel auf pnpm 12, sobald Contributors
  es per Corepack bzw. Installer nutzen – reine Änderung des `packageManager`-Felds.
- **Supply-Chain-Schutz:** pnpm 11 installiert standardmäßig keine Versionen, die jünger als die
  `minimumReleaseAge` sind, und blockiert Install-Skripte; erlaubt ist nur `esbuild`
  (`allowBuilds` in `pnpm-workspace.yaml`).

## Konsequenzen

- Contributors brauchen Node ≥ 24.15, pnpm (beliebige Version ≥ 10 schaltet automatisch um) und Docker.
- Migrationen werden mit `pnpm --filter @raglab/api db:generate` aus `src/db/schema.ts` erzeugt und
  vor dem Commit geprüft; Custom-SQL (z. B. HNSW-Index) über `drizzle-kit generate --custom`.
- Sprache: Code, API und öffentliche Repository-Dateien (README, CONTRIBUTING, …) auf Englisch;
  Architektur-Dokumentation und Arbeitsprompts auf Deutsch (Arbeitssprache des Maintainers).

## Nachtrag (Prompt 015, 2026-11-02)

- Container-Basis: `node:26.13.0-trixie-slim` (vorher `bookworm-slim`; Debian 13 ist das aktuelle
  Stable-Release, PostgreSQL läuft bereits auf `pgvector/pgvector:0.8.7-pg18-trixie`) und
  `nginxinc/nginx-unprivileged:1.30.6-alpine` (Stable-Linie, exakter Patch-Tag statt `1.30-alpine`).
  Tags per Docker-Hub-API/`docker manifest inspect` geprüft; Updates über Dependabot.
- pnpm bleibt `11.28.9` (`packageManager`); 11.28.10 ist verfügbar, ein Wechsel ist reine
  Pflege und nicht Teil von 015.
- Versionierung und Release: gemeinsame SemVer-Version aller Pakete, Skript statt Changesets –
  Begründung in [release.md](../release.md) §1.
