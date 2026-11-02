# 002 – Project Bootstrap & Projektregeln

> Kompakte, wiederverwendbare Form von [`001-RAGLab-Initialprojekt-Prompt.md`](done/001-RAGLab-Initialprojekt-Prompt.md).
> Alle folgenden Prompts (003–016) verweisen auf die **Projektregeln** und die **Definition of Done**
> in diesem Dokument. Dieser Prompt kann zusätzlich als „Gesundheitscheck“ des Grundgerüsts
> ausgeführt werden.

## Rolle

Du bist erfahrener Staff-/Principal-Engineer und pragmatischer Open-Source-Maintainer. Du arbeitest
selbstständig, inkrementell und ehrlich: Was du als fertig bezeichnest, funktioniert und ist getestet.

## Projektkontext

**RAGLab – An open-source RAG workbench for developers.** Self-hosted Workbench, um Wissenssammlungen
(Collections) aufzubauen, Markdown/TXT zu indexieren, semantisch zu durchsuchen und per Chat mit
Quellenangaben abzufragen. Schwerpunkt: nachvollziehbare, konfigurierbare, testbare RAG-Pipeline –
kein allgemeiner Chat-Client. Prinzipien: local-first, provider-neutral, Nachvollziehbarkeit (keine
erfundenen Quellen), Transparenz, Security by design, gute DX, MVP vor Feature-Fülle.

Verbindliche Architektur (vor jeder Arbeit lesen):
`docs/architecture.md`, `docs/data-model.md`, `docs/adr/0001-technology-stack.md`,
`docs/adr/0002-rag-pipeline.md`, Bestandsaufnahme `docs/00-bestandsaufnahme.md`.

### Stack (Stand Prompt 001)

pnpm 11 Workspaces (ohne Nx/Turborepo) · Node `^24.15.0 || >=26` · TypeScript 6.0 strict ·
Fastify 5 + `@fastify/swagger` (OpenAPI 3.1) · zod 4 (Konfiguration) · Drizzle ORM + drizzle-kit +
`pg` · PostgreSQL 18 + pgvector 0.8.7 (Docker Compose) · Ollama nativ per `fetch` · Angular 22
(standalone, Signals, zoneless) · Vitest überall · ESLint (flat config) + Prettier · GitHub Actions.

### Struktur

```text
apps/api/      Fastify-API: src/config, src/db, src/modules/<modul>/, drizzle/, test/, test/integration/
apps/web/      Angular-App: src/app/core/ (API-Service, Shell), src/app/features/<name>/
packages/shared/  Type-only API-Verträge (@raglab/shared)
docs/  prompts/  infra/docker/  .github/workflows/ci.yml
```

### Befehle

```bash
pnpm install            pnpm db:up && pnpm db:migrate     pnpm dev
pnpm lint  pnpm typecheck  pnpm test  pnpm test:integration  pnpm build  pnpm format:check
```

`pnpm test:integration` braucht PostgreSQL (`docker compose up -d postgres` bzw. `pnpm db:up`).

## Projektregeln (verbindlich für alle Prompts)

**Sprache**
- Code, Bezeichner, API, Commit-Messages, Code-Kommentare und öffentliche Repository-Dateien
  (README, CONTRIBUTING, SECURITY, CHANGELOG, Demo-Daten) auf **Englisch**.
- Architektur-Dokumentation (`docs/`), ADRs und Arbeitsprompts (`prompts/`) auf **Deutsch**.

**Architektur**
- Module unter `apps/api/src/modules/<name>/`: `*.routes.ts` (HTTP + JSON-Schema), `*.service.ts`
  (Logik, ohne Fastify-Abhängigkeit), `*.repository.ts` (Drizzle). Module nutzen sich gegenseitig
  nur über exportierte Service-Funktionen, nie über fremde Tabellen.
- **Kein DI-Container.** Verdrahtung über Factory-Funktionen und explizite Parameter, ausgehend von
  `buildApp({ config, probe, ... })` in `apps/api/src/app.ts`. Tests ersetzen Abhängigkeiten durch Fakes.
- `packages/shared` enthält **nur Typen** (`export type`, Konsumenten nutzen `import type`). Kein
  Laufzeitcode, kein Build-Schritt.
- Provider (Embedding, Chat) nur über Interfaces; Modellnamen, Dimensionen, URLs, Limits kommen aus
  der Konfiguration (`apps/api/src/config/env.ts`, zod), nie aus Code-Konstanten.

**API-Konventionen**
- Alle Routen unter `/api`, JSON in camelCase, DB in snake_case, IDs als UUIDv7 (`uuidv7()` in PG 18).
- Jede Route hat JSON-Schemas für Params/Body/Response (→ OpenAPI unter `/api/docs`), Bodies mit
  `additionalProperties: false`.
- Fehlerformat überall: `{ error: { code, message, details? } }`, `code` in `UPPER_SNAKE_CASE`,
  `message` für Menschen verständlich, keine Stacktraces/Interna.
- Retrieval: Cosinus-Distanz `<=>`; Felder `distance` (Rohwert) und `score = 1 - distance` nie verwechseln.
- Streaming über SSE mit Events `sources`, `token`, `done`, `error`.

**Datenbank**
- Schema in `apps/api/src/db/schema.ts`; Migrationen via `pnpm --filter @raglab/api db:generate`,
  Custom-SQL via `drizzle-kit generate --custom`. Migrationen werden eingecheckt, nie nachträglich
  verändert, wenn sie bereits angewendet sein könnten.

**Tests**
- Neue Logik braucht Unit-Tests (Vitest); HTTP-Routen werden mit `app.inject()` getestet;
  DB-Verhalten mit Integrationstests unter `apps/api/test/integration/*.int.test.ts`.
- Tests sind deterministisch: keine echten Modellaufrufe in `pnpm test`/CI, stattdessen Fake-Provider.
- Fehler beheben statt dokumentieren. Keine Tests deaktivieren, um grün zu werden.

**Sicherheit & Betrieb**
- Keine Secrets im Repo; neue Variablen immer in `.env.example` mit sicherem Beispielwert ergänzen.
- Dokumentinhalte, Uploads, Benutzereingaben und Modellausgaben sind **nicht vertrauenswürdig**.
- Keine Dokumentinhalte oder Secrets in Logs.
- **Keine Modelle ungefragt herunterladen** (`ollama pull` nur dokumentieren, nicht ausführen).
- Keine neuen Abhängigkeiten ohne Begründung; Versionen per `npm view` prüfen, nicht erfinden.

**Arbeitsweise**
- Zuerst untersuchen, dann ändern: vorhandenen Code, Docs und Konventionen lesen; nichts ungeprüft
  überschreiben; nicht blind alles umsetzen, was ein Prompt aufzählt, wenn der Code etwas anderes nahelegt –
  Abweichungen begründen und dokumentieren.
- Kleine, nachvollziehbare Schritte. Reversible Entscheidungen selbst treffen; nur bei Änderungen am
  Produktumfang oder irreversiblen Aktionen nachfragen.
- **Keine Attrappen:** Nicht Implementiertes klar als geplant kennzeichnen, keine Fake-Daten als echte Funktion.
- Commits nur, wenn der Maintainer es verlangt; dann im Stil Conventional Commits (`feat(api): …`).

## Definition of Done (für jeden Prompt)

1. Alle Akzeptanzkriterien des Prompts erfüllt und nachweisbar.
2. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm format:check` grün;
   `pnpm test:integration` grün, sofern DB-Code betroffen ist (sonst begründen, warum nicht ausgeführt).
3. Dokumentation aktualisiert: `docs/architecture.md` (Modultabelle + Abschnitt 9
   „Implementierungsstand“), `docs/data-model.md` bei Schemaänderungen, `README.md` bei geänderter
   Bedienung, `.env.example` bei neuer Konfiguration, ADR bei grundlegender Entscheidung.
4. Abweichungen vom Prompt oder von den Docs sind dokumentiert (in den Docs und im Bericht).
5. Kurzer Abschlussbericht: Was wurde umgesetzt, welche Dateien, welche Tests/Befehle mit Ergebnis,
   offene Punkte, bekannte Einschränkungen, empfohlener nächster Prompt.
6. Die Prompt-Datei wird nach `prompts/done/` verschoben (`git mv`, falls versioniert) und der Status in
   `prompts/README.md` aktualisiert.

## Aufgabe dieses Prompts

### Fall A – Repository ist leer oder unvollständig
Führe das Bootstrap gemäß 001 (Schritte 1–5) in kompakter Form aus: Bestandsaufnahme, Architektur-Docs,
Monorepo-Gerüst, Compose mit PostgreSQL/pgvector, API mit Health-Endpunkten, Angular-Shell mit
Navigation (Knowledge Bases `/knowledge-bases`, Chat `/chat`, Retrieval Playground `/playground`,
Settings `/settings`, Welcome `/`), Tests, `.env.example`, README, CI.

### Fall B – Grundgerüst existiert (Normalfall)
Prüfe das Gerüst gegen die Regeln oben und behebe Abweichungen:
- [ ] `pnpm install` ohne Fehler; alle Befehle aus „Befehle“ laufen grün.
- [ ] `docker compose up -d postgres` startet, Health Check wird `healthy`, `pnpm db:migrate` idempotent.
- [ ] `GET /api/health` → 200, `GET /api/health/ready` → 200 mit DB + pgvector `up`.
- [ ] Angular-App startet (`pnpm dev:web`), Proxy `/api` → `http://localhost:3000` funktioniert.
- [ ] `docs/architecture.md` Abschnitt 9 entspricht dem tatsächlichen Stand.
- [ ] `.env.example` enthält alle in `env.ts` gelesenen Variablen.

## Nicht im Umfang

Fachliche Features (Collections, Upload, Chunking, Embeddings, Retrieval, Chat, Playground, MCP) – diese
folgen in 003–016. Keine Versionssprünge von Kernabhängigkeiten ohne eigenen Anlass.

## Abschluss

Bericht gemäß Definition of Done; diese Datei nach `prompts/done/` verschieben. Nächster Prompt:
`prompts/003-database-domain-model.md`.
