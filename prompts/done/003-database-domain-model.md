# 003 – Datenbank- und Domänenmodell (Collections, Documents, Chunks)

## Kontext

RAGLab ist eine self-hosted RAG-Workbench (Fastify-API, Angular-Web, PostgreSQL 18 + pgvector).
Mit 001/002 existieren Monorepo, Compose-Datenbank, Migration `0000_enable_pgvector`, Health-/
Readiness-Endpunkte und eine Angular-Shell. Es gibt **noch keine Domänentabellen**.

Dieser Prompt legt das Datenmodell aus `docs/data-model.md` an, führt das einheitliche Fehlerformat
ein und liefert eine vollständige CRUD-API für Collections plus lesende Endpunkte für Dokumente.

**Voraussetzung:** 002 (Projektregeln, Definition of Done) gelesen; Grundgerüst grün.

## Zuerst untersuchen

- `docs/data-model.md` (Zielmodell – verbindlich), `docs/architecture.md` §3, §7, ADR 0001/0002.
- `apps/api/src/app.ts` (`buildApp({ config, probe, logger })`), `src/db/{client,schema,probe,migrate}.ts`,
  `drizzle/0000_enable_pgvector.sql`, `drizzle.config.ts`, `src/modules/system/*.routes.ts`
  (Stil für Routen + JSON-Schema), `test/helpers.ts`, `test/integration/database.int.test.ts`,
  `vitest.integration.config.ts`.
- `packages/shared/src/*.ts` (type-only Konventionen).
- Prüfe, wie Drizzle 0.45 `vector(...)`, `pgEnum`, Default `uuidv7()` (via `sql`) und
  Unique-Indizes auf Ausdrücken (`lower(name)`) abbildet. Was Drizzle nicht kann → Custom-Migration.
Respektiere bestehende Konventionen; weiche nur begründet ab.

## Ziele

1. Drizzle-Schema + Migrationen für `collections`, `documents`, `chunks` und Enum `document_status`
   exakt nach `docs/data-model.md` (inkl. Constraints, Cascades, Indizes).
2. HNSW-Index `USING hnsw (embedding vector_cosine_ops)` als Custom-Migration.
3. Einheitliches Fehlerformat `{ error: { code, message, details? } }` für alle Routen.
4. Collections-CRUD und lesende Dokument-Endpunkte.
5. Readiness prüft zusätzlich, dass die Dimension von `chunks.embedding` zu `EMBEDDING_DIMENSIONS` passt.

## Umsetzung (Vorschlag)

**Datenbank**
- `apps/api/src/db/schema.ts`: Tabellen, Enum, Relationen. `chunks.embedding` als
  `vector('embedding', { dimensions: 768 })` – die Zahl ist eine **Migrationsentscheidung** und muss
  zu `.env.example` passen; eine benannte Konstante (z. B. `EMBEDDING_COLUMN_DIMENSIONS`) mit Kommentar,
  dass eine Änderung eine Migration + Re-Indexierung erfordert.
- `apps/api/drizzle/0001_*.sql` (generiert) und `0002_*.sql` (custom: HNSW-Index, `lower(name)`-Unique,
  CHECK `length(trim(content)) > 0`, falls nicht generierbar). Migrationen nicht von Hand umbenennen,
  wenn das Journal sie referenziert.

**Fehlerbehandlung** – `apps/api/src/http/errors.ts` (oder ähnlich, begründen)
- Klasse `AppError(statusCode, code, message, details?)` plus Helfer (`notFound`, `conflict`, …).
- Zentraler `setErrorHandler` und `setNotFoundHandler` in `buildApp`: Fastify-Validierungsfehler →
  `400 VALIDATION_ERROR` mit `details`; Unique-Verletzungen (`23505`) → `409`; unbekannte Fehler →
  `500 INTERNAL_ERROR` ohne Interna (Log mit Request-ID).
- Typ `ApiErrorResponse` in `packages/shared/src/errors.ts`.

**Modul `collections`** – `apps/api/src/modules/collections/`
- `collections.repository.ts`, `collections.service.ts`, `collections.routes.ts`.
- Beim Anlegen werden `embedding_provider`, `embedding_model`, `embedding_dimensions` aus der aktuellen
  Konfiguration übernommen (nicht vom Client).

| Methode | Pfad | Ergebnis |
|---|---|---|
| `POST` | `/api/collections` | `201` + Collection; Body `{ name, description? }`; `409 COLLECTION_NAME_TAKEN` |
| `GET` | `/api/collections` | `200` Liste inkl. `documentCount`, `readyDocumentCount`, `chunkCount` |
| `GET` | `/api/collections/:id` | `200` / `404 COLLECTION_NOT_FOUND` |
| `PATCH` | `/api/collections/:id` | Name/Beschreibung ändern (Embedding-Felder unveränderlich) |
| `DELETE` | `/api/collections/:id` | `204`, kaskadiert Dokumente und Chunks |

**Modul `documents`** (nur lesend/löschend; Upload folgt in 004) – `apps/api/src/modules/documents/`

| Methode | Pfad | Ergebnis |
|---|---|---|
| `GET` | `/api/collections/:id/documents` | Liste (Metadaten, **ohne** `content`) |
| `GET` | `/api/documents/:id` | Metadaten inkl. `status`, `errorMessage`, `chunkCount` |
| `DELETE` | `/api/documents/:id` | `204`, kaskadiert Chunks |

**Verdrahtung**
- `buildApp` erhält zusätzlich die DB (z. B. `db: Database`) bzw. fertige Services; `main.ts` erzeugt sie.
  Unit-Tests der Routen nutzen Fake-Repositories/-Services, keine DB.
- UUID-Path-Params per JSON-Schema (`format: 'uuid'`) validieren → ungültige ID ergibt `400`, nicht `500`.

**Shared Types** – `packages/shared/src/collections.ts`, `documents.ts`, `errors.ts`:
`CollectionDto`, `CreateCollectionRequest`, `UpdateCollectionRequest`, `DocumentDto`, `DocumentStatus`
(`'pending' | 'processing' | 'ready' | 'failed'`), `ApiErrorResponse`. Zeitstempel als ISO-Strings.

**Readiness** – `src/db/probe.ts` liest die Spaltendimension aus dem Katalog (`atttypmod` von
`chunks.embedding`) und meldet einen zusätzlichen Check (z. B. `checks.schema`) mit
`expected`/`actual`; Abweichung → `not_ready` + verständliche Meldung. `ReadinessResponse` erweitern.

## Nicht im Umfang

- Upload, Textextraktion, Normalisierung (004), Chunking (005), Embeddings (006), Suche (007).
- `chat_sessions`/`chat_messages`, `chunk_embeddings`, `tsvector`/hybride Suche, Job-Tabelle.
- Pagination (Listen dürfen im MVP vollständig sein; Limit dokumentieren, falls eingeführt).
- UI-Änderungen (009).

## Akzeptanzkriterien

- [ ] `pnpm db:migrate` legt alle Tabellen, Enum, FKs mit `ON DELETE CASCADE`, Indizes (inkl. HNSW
      mit `vector_cosine_ops`) an und ist idempotent.
- [ ] Name ist case-insensitive eindeutig (`Docs` und `docs` kollidieren → `409`).
- [ ] `chunks` erzwingt nicht-leeren Inhalt und Unique `(document_id, chunk_index)`;
      `documents` Unique `(collection_id, content_sha256)`.
- [ ] Alle neuen Endpunkte erscheinen mit Schemas in `/api/docs/json`.
- [ ] Jede Fehlerantwort (inkl. 404 unbekannte Route, 400 Validierung) hat das Format
      `{ error: { code, message, details? } }`.
- [ ] Collection übernimmt Embedding-Provider/-Modell/-Dimension aus der Konfiguration.
- [ ] Readiness meldet `not_ready`, wenn `EMBEDDING_DIMENSIONS` ≠ Spaltendimension.
- [ ] `packages/shared` bleibt type-only.

## Tests

- Unit (`apps/api/test/`): Error-Handler (Validierung, 404, 409, 500 ohne Interna), Collections-Routen
  mit Fake-Service via `app.inject()`, Service-Logik (Übernahme der Embedding-Konfiguration).
- Integration (`apps/api/test/integration/collections.int.test.ts`, `schema.int.test.ts`):
  Migration anwenden, CRUD gegen echte DB, Cascade-Löschung (Collection → Documents → Chunks, Chunks
  ggf. per SQL einfügen), Unique-Constraints, CHECK-Constraint, HNSW-Index existiert (`pg_indexes`),
  Readiness mit passender/unpassender Dimension.
- Ein gemeinsamer Integrations-Helfer leert Tabellen zwischen Tests (`TRUNCATE … CASCADE`); Tests
  dürfen nicht voneinander abhängen.

```bash
pnpm db:up && pnpm db:migrate
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build && pnpm format:check
```

## Dokumentation & Abschluss

- `docs/data-model.md`: Status „implementiert“, tatsächliche Migrationsnamen, Abweichungen.
- `docs/architecture.md`: Modultabelle (`collections`, `documents` teilweise), §7 Fehlerformat als
  implementiert, §9 Implementierungsstand.
- README (API-Abschnitt), ggf. `.env.example`.
- Abschlussbericht gemäß 002; Datei nach `prompts/done/` verschieben. Nächster Prompt: `004-document-ingestion.md`.
