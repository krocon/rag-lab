# RAGLab – Datenmodell

Stand: 2026-11-02 · **Implementiert** mit
[prompts/done/003-database-domain-model.md](../prompts/done/003-database-domain-model.md)
(Migrationen `0000_enable_pgvector`, `0001_domain_model`). Schema-Quelle:
[`apps/api/src/db/schema.ts`](../apps/api/src/db/schema.ts). Umsetzungsdetails und Abweichungen
stehen im Abschnitt [Umsetzung](#umsetzung).

## Überblick

```text
collections 1 ──── n documents 1 ──── n chunks (inkl. embedding vector(n))
     │                                    ▲
     └──────────────── 1 : n ─────────────┘   (collection_id denormalisiert für Filter)
```

- **Embedding wird direkt am Chunk gespeichert** (Spalte `embedding`), da im MVP genau ein
  Embedding-Modell aktiv ist. Mehrere Modelle parallel → eigene Tabelle `chunk_embeddings`
  (siehe „Erweiterungen“).
- `ChatSession`/`ChatMessage` sind **nicht Teil des MVP**: Der Chat ist zunächst zustandslos, der
  Verlauf lebt im Browser. Persistenz erst, wenn ein Feature (z. B. Verlauf, Auswertung) sie braucht.
- IDs: `uuid` (v7 via `uuidv7()`, in PostgreSQL 18 eingebaut) – zeitlich sortierbar, stabil, nicht
  erratbar. Quellenreferenzen nutzen immer `documentId` + `chunkId`, nie Dateinamen.
- Zeitstempel: `timestamptz`, `created_at`/`updated_at` (Default `now()`).
- Löschen: `ON DELETE CASCADE` von Collection → Documents → Chunks.

## Tabellen

### `collections` – Knowledge Base

| Spalte                     | Typ                    | Hinweise                                                                    |
| -------------------------- | ---------------------- | --------------------------------------------------------------------------- |
| `id`                       | `uuid` PK              | `DEFAULT uuidv7()`                                                          |
| `name`                     | `text` NOT NULL        | 1–120 Zeichen, eindeutig (case-insensitive, Unique-Index auf `lower(name)`) |
| `description`              | `text` NULL            | max. 2.000 Zeichen                                                          |
| `embedding_provider`       | `text` NOT NULL        | Provider zum Zeitpunkt der Anlage, z. B. `ollama`                           |
| `embedding_model`          | `text` NOT NULL        | Modell, mit dem alle Chunks dieser Collection eingebettet sind              |
| `embedding_dimensions`     | `integer` NOT NULL     | muss zur Spalte `chunks.embedding` passen                                   |
| `source`                   | `jsonb` NULL           | Import-Quelle (017): `kind`, `url` (ohne Zugangsdaten), `ref`, `commit`, `importedAt` |
| `created_at`, `updated_at` | `timestamptz` NOT NULL |                                                                             |

Das Embedding-Modell wird pro Collection festgehalten, damit ein späterer Modellwechsel erkannt
werden kann (Suche mit anderem Modell als bei der Indexierung ist fachlich falsch → Fehler bzw.
Re-Indexierung erforderlich).

`source` (Prompt 017, [ADR 0004](adr/0004-source-import.md)) setzt `pnpm kb:import` über
`PUT /api/collections/:id/source`; der Service validiert (`kind` ∈ `directory`/`git`, `url` nur
`https://`, `ssh://`, `git@host:path` **ohne** Zugangsdaten, `ref` ohne Sonderzeichen, `commit` als
40/64-stellige Hex-SHA) und setzt `importedAt`. Mit `url` + `commit` eines bekannten Hosts bildet
der Server Links auf den Quelltext (`sourceUrl`). Eine Collection hat genau eine Quelle (die
zuletzt importierte).

### `documents`

| Spalte                     | Typ                             | Hinweise                                                                |
| -------------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| `id`                       | `uuid` PK                       |                                                                         |
| `collection_id`            | `uuid` FK → `collections`       | `ON DELETE CASCADE`, Index                                              |
| `filename`                 | `text` NOT NULL                 | Originalname bzw. letztes Pfadsegment, nur zur Anzeige (bereinigt)      |
| `path`                     | `text` NULL                     | relativer Pfad im Import (017); Unique `(collection_id, path)` partiell |
| `mime_type`                | `text` NOT NULL                 | aus der Endung (Allowlist, `ingestion/file-type.ts`); bestimmt Sprache  |
| `size_bytes`               | `integer` NOT NULL              | Größe der Originaldatei                                                 |
| `content_sha256`           | `text` NOT NULL                 | Hash des normalisierten Texts; Unique `(collection_id, content_sha256)` |
| `content`                  | `text` NOT NULL                 | normalisierter Volltext (Basis für Re-Chunking und Quellenansicht)      |
| `status`                   | `document_status` NOT NULL      | Enum: `pending`, `processing`, `ready`, `failed`                        |
| `error_message`            | `text` NULL                     | nur bei `failed`, für Benutzer verständlich, ohne Stacktrace            |
| `chunk_count`              | `integer` NOT NULL DEFAULT 0    |                                                                         |
| `metadata`                 | `jsonb` NOT NULL DEFAULT `'{}'` | `title` aus erster Markdown-Überschrift (004), sonst `{}`               |
| `created_at`, `updated_at` | `timestamptz` NOT NULL          |                                                                         |

`path` (Prompt 017): vom Client im Formularfeld `path` gesendet, streng validiert (relativ, `/` als
Trenner, keine `.`/`..`/leeren Segmente, keine Steuer-, Bidi- oder unsichtbaren Zeichen, keine
Leerzeichen am Segmentrand, Segment ≤ 255, gesamt ≤ 512 Zeichen, NFC). Die 512 Zeichen halten
den btree-Eintrag des Unique-Index unter der Größengrenze. `NULL` für Uploads ohne Pfad (Web-App,
`demo:seed`); der partielle Index `WHERE path IS NOT NULL` betrifft sie nicht. Reine
Anzeige-/Metadaten-Information, nie ein Dateisystempfad. Die Sprache (`language` im DTO) wird
aus `mime_type` abgeleitet und nicht gespeichert. Liste: sortiert nach `path ASC NULLS LAST`,
Präfixfilter mit `starts_with(path, $1)` (wörtlich, ohne LIKE-Platzhalter).

Statusübergänge: `pending → processing → ready | failed`; `failed → processing` bei erneutem Versuch;
`failed | ready → pending` per Reindex (006, `ready` nur mit fehlenden Embeddings).

Umsetzung der Statusübergänge (Prompt 004, `documents.repository.ts`): `claimForProcessing` setzt
atomar `processing` (`UPDATE … WHERE status IN ('pending','failed') RETURNING …`), `markReady` und
`markFailed` greifen nur, solange das Dokument `processing` ist (gelöschte Dokumente werden still
übergangen). Beim Start setzt die Recovery alle `processing`-Dokumente auf `failed` mit Hinweis
(siehe [architecture.md §4.1](architecture.md#41-indexierung-upload--durchsuchbar)).

### `chunks`

| Spalte                       | Typ                              | Hinweise                                                                        |
| ---------------------------- | -------------------------------- | ------------------------------------------------------------------------------- |
| `id`                         | `uuid` PK                        | stabile Referenz für Quellenangaben                                             |
| `document_id`                | `uuid` FK → `documents`          | `ON DELETE CASCADE`                                                             |
| `collection_id`              | `uuid` FK → `collections`        | denormalisiert, damit der Collection-Filter ohne Join in der Vektorsuche greift |
| `chunk_index`                | `integer` NOT NULL               | 0-basiert, Unique `(document_id, chunk_index)`                                  |
| `content`                    | `text` NOT NULL                  | nicht leer (CHECK `length(trim(content)) > 0`)                                  |
| `start_offset`, `end_offset` | `integer` NOT NULL               | Zeichenpositionen im normalisierten Dokumenttext                                |
| `char_count`                 | `integer` NOT NULL               |                                                                                 |
| `token_estimate`             | `integer` NULL                   | grobe Schätzung (`ceil(char_count / 4)`), nur informativ                        |
| `heading_path`               | `text[]` NOT NULL DEFAULT `'{}'` | z. B. `{"Installation","Docker"}` (Markdown); Code: `{Pfad, Symbol}`            |
| `metadata`                   | `jsonb` NOT NULL DEFAULT `'{}'`  | `overlapChars`; seit 017 `startLine`, `endLine` (1-basiert), `symbol` (Code)    |
| `embedding`                  | `vector(768)` NULL               | NULL bis eingebettet; Dimension = `EMBEDDING_DIMENSIONS`                        |
| `created_at`, `updated_at`   | `timestamptz` NOT NULL           |                                                                                 |

Chunk-Metadaten seit Prompt 017: `startLine`/`endLine` (Zeile des ersten und letzten Zeichens,
für alle Formate) und bei Quellcode `symbol` (umgebende Top-Level-Deklaration(en), z. B.
`class TreeTableModel`). Chunks, die vor 017 gespeichert wurden, haben diese Schlüssel nicht
(`null` im DTO), bis das Dokument neu indexiert wird; es gibt keine Datenmigration.

Indizes:

- `chunks (collection_id)` – Filter
- HNSW: `CREATE INDEX … ON chunks USING hnsw (embedding vector_cosine_ops)` – passend zum
  Operator `<=>` (Cosinus-Distanz)
- `documents (collection_id, status)`
- `documents (collection_id, path) WHERE path IS NOT NULL` – eindeutig; Sortierung und Präfixfilter

## Umsetzung

| Migration                  | Art                       | Inhalt                                                                                                          |
| -------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `0000_enable_pgvector.sql` | Custom (Prompt 001)       | `CREATE EXTENSION IF NOT EXISTS vector`                                                                         |
| `0001_domain_model.sql`    | generiert (`db:generate`) | Enum `document_status`, Tabellen, FKs (`ON DELETE CASCADE`), Unique-/CHECK-Constraints, alle Indizes inkl. HNSW |
| `0002_source_import.sql`   | generiert (Prompt 017)    | `collections.source` (jsonb), `documents.path` + partieller Unique-Index `(collection_id, path) WHERE path IS NOT NULL` + CHECK Länge 1–512 |

Index- und Constraint-Namen (stabil, werden im Code referenziert):

| Name                                            | Art                                        |
| ----------------------------------------------- | ------------------------------------------ |
| `collections_name_lower_unique`                 | Unique-Index auf `lower(name)`             |
| `documents_collection_id_content_sha256_unique` | Unique `(collection_id, content_sha256)`   |
| `documents_collection_id_status_idx`            | Index `(collection_id, status)`            |
| `chunks_document_id_chunk_index_unique`         | Unique `(document_id, chunk_index)`        |
| `chunks_collection_id_idx`                      | Index `(collection_id)`                    |
| `chunks_embedding_hnsw_idx`                     | `USING hnsw (embedding vector_cosine_ops)` |
| `chunks_content_not_blank`                      | CHECK `length(trim(content)) > 0`          |

**Abweichungen und Ergänzungen gegenüber dem Zielmodell bzw. Prompt 003:**

- **Keine Custom-Migration `0002`:** Drizzle 0.45 / drizzle-kit 0.31 erzeugen HNSW-Index mit
  Operator-Klasse (`index().using('hnsw', col.op('vector_cosine_ops'))`), Ausdrucks-Unique-Index
  (``uniqueIndex().on(sql`lower(name)`)``), CHECK-Constraints (`check()`) und den Default
  `uuidv7()` (``default(sql`uuidv7()`)``) selbst. Alles liegt daher in `schema.ts` und in der
  generierten Migration `0001`; Schema-Snapshot und Datenbank bleiben deckungsgleich, und ein
  späteres `db:generate` würde den Index nicht verlieren.
- **Kein separater Index `documents (collection_id)`:** Der Index `(collection_id, status)` und der
  Unique-Index `(collection_id, content_sha256)` beginnen mit `collection_id` und decken Filter und
  FK-Cascade ab. Ebenso deckt `chunks (document_id, chunk_index)` die FK-Cascade von `documents` ab.
- **Zusätzliche CHECK-Constraints** (defensiv, Werte aus dem Zielmodell): `collections_name_length`
  (1–120 Zeichen), `collections_description_length` (≤ 2.000), `collections_embedding_dimensions_positive`,
  `chunks_chunk_index_non_negative`, `chunks_offsets_valid` (`0 ≤ start_offset ≤ end_offset`).
- `documents.status` hat den Default `pending`.
- `updated_at` wird von Drizzle bei jedem `UPDATE` über das ORM gesetzt (`$onUpdate`), nicht per
  Trigger. Direkte SQL-Updates müssen `updated_at` selbst setzen.
- Die Spaltendimension steht als Konstante `EMBEDDING_COLUMN_DIMENSIONS = 768` in `schema.ts`; ein
  Unit-Test stellt sicher, dass sie zu `EMBEDDING_DIMENSIONS` in `.env.example` passt.
- **Ingestion (004), keine Schemaänderung:** `filename` ist der bereinigte Anzeigename (max. 255
  Zeichen), `mime_type` wird aus der Endung abgeleitet, `size_bytes` ist die Größe der Originaldatei,
  `content`/`content_sha256` beziehen sich auf den normalisierten Text. Mehrere Dateien einer Anfrage
  werden in einer `INSERT`-Anweisung gespeichert; der Unique-Index
  `documents_collection_id_content_sha256_unique` sichert die Duplikaterkennung auch bei parallelen
  Uploads ab (→ `409 DUPLICATE_DOCUMENT`). `metadata` ist in Drizzle als `DocumentMetadataFields`
  (`@raglab/shared`) typisiert.
- **Chunking (005), keine Schemaänderung:** Das Modul `chunking` besitzt `chunks`
  (`chunks.repository.ts`) und ersetzt die Chunks eines Dokuments in einer Transaktion. Nutzung
  der Spalten:
  - `content` = `documents.content.slice(start_offset, end_offset)`; Offsets in UTF-16-Code-Units
    (JavaScript-String-Offsets), getrimmt – ein Chunk beginnt und endet nie mit Whitespace.
  - `char_count` = Länge von `content` in UTF-16-Code-Units; `token_estimate` = `ceil(char_count / 4)`,
    nur informativ (kein Modell-Tokenizer, gesetzt für jeden Chunk).
  - `heading_path` = Texte der umschließenden ATX-Überschriften, äußerste zuerst (z. B.
    `{"Getting started","Installation","Docker"}`); `{}` für Text vor der ersten Überschrift und
    für `.txt`.
  - `metadata` = `{ "overlapChars": n }`: Länge des Anfangs, der aus dem vorherigen Chunk
    wiederholt wird (`0` = kein Overlap). Weitere Schlüssel bleiben späteren Formaten vorbehalten.
  - `embedding` bleibt bis zum Embedding-Schritt `NULL` (seit 006, siehe unten);
    `documents.chunk_count` wird beim Übergang nach `ready` gesetzt und entspricht der Zahl der Zeilen.
- **Embeddings (006), keine Schemaänderung:** Der Embedding-Schritt schreibt `chunks.embedding`
  für alle Chunks eines Dokuments in **einer Transaktion** (`UPDATE chunks … FROM (VALUES …)`,
  Vektoren als pgvector-Textliteral `[x,y,…]`, unverändert wie vom Provider geliefert, nicht
  normalisiert). `ready` heißt seither: jeder Chunk hat einen Vektor der Länge
  `EMBEDDING_COLUMN_DIMENSIONS`. Vor dem Schreiben werden Provider/Modell/Dimension gegen
  `collections.embedding_provider/model/dimensions` geprüft; bei Abweichung bleibt `embedding`
  `NULL` und das Dokument wird `failed` (`EMBEDDING_MODEL_MISMATCH`). Reindex
  (`POST /api/documents/:id/reindex`) setzt `failed`-Dokumente bzw. `ready`-Dokumente mit
  `embedding IS NULL`-Chunks per bedingtem `UPDATE` zurück auf `pending`; Statusübergänge damit:
  `failed → pending`, `ready → pending` (nur mit fehlenden Embeddings).
- Die Collection-Liste zählt `documentCount`, `readyDocumentCount` und `chunkCount` per korrelierter
  Unterabfrage (nutzt die Indizes oben); `chunkCount` zählt tatsächliche Zeilen in `chunks`, nicht
  die Summe von `documents.chunk_count`.

## Embedding-Dimension

Die Dimension steht an drei Stellen und muss übereinstimmen:

1. `EMBEDDING_DIMENSIONS` in der Konfiguration (validiert: 1–2.000),
2. die Spalte `chunks.embedding vector(n)` (Migration),
3. die tatsächliche Ausgabe des Modells.

Die API liest beim Readiness-Check (`GET /api/health/ready`, `checks.schema`) die Spaltendimension
aus dem Katalog (`pg_attribute.atttypmod` von `chunks.embedding`) und vergleicht sie mit der
Konfiguration. Abweichung oder fehlende Spalte → `checks.schema.status = 'down'` mit
`expected`/`actual` und Hinweis, Gesamtstatus `not_ready` (`503`).
Ein Modellwechsel mit anderer Dimension erfordert eine neue Migration (Spalte ändern, Index neu
bauen, Chunks neu einbetten). Über 2.000 Dimensionen: `halfvec` (HNSW bis 4.000) – bewusst nicht
im MVP.

## Distanz und Score

Gespeichert und abgefragt wird **Cosinus-Distanz** (`embedding <=> query`, Bereich 0–2, kleiner ist
ähnlicher). Die API liefert beide Werte eindeutig benannt:

- `distance` = Rohwert des Operators,
- `score` = `1 - distance` (Cosinus-Ähnlichkeit, −1…1, größer ist ähnlicher).

**Umsetzung (007), keine Schemaänderung:** Operator `<=>`, Opclass `vector_cosine_ops` und
`toScore` sind einmal in `apps/api/src/modules/retrieval/similarity.ts` definiert (`schema.ts`
nutzt die Opclass-Konstante). Die Suche filtert in **einer** Abfrage auf `chunks.collection_id`,
`chunks.embedding IS NOT NULL` und `documents.status = 'ready'` (Join über `document_id`) vor
`ORDER BY embedding <=> $q LIMIT topK`. In derselben Transaktion gelten
`hnsw.iterative_scan = relaxed_order` und `hnsw.ef_search = max(40, topK)` (per
`set_config(…, true)` ≙ `SET LOCAL`), damit der Collection-Filter nach dem HNSW-Scan nicht zu
wenige Treffer übrig lässt; weil `relaxed_order` leicht ungeordnet liefern kann, sortiert die
Anwendung danach stabil nach `distance`. Nutzt der Planer statt HNSW den Index
`chunks_collection_id_idx` mit Sortierung (kleine Collections), ist das Ergebnis exakt. Details:
[architecture.md §4.3](architecture.md#43-umsetzung-retrieval-prompt-007).

## Erweiterungen (nicht MVP)

- `chunk_embeddings (chunk_id, model, dimensions, embedding)` für mehrere Modelle/A-B-Vergleiche
- `tsvector`-Spalte + GIN-Index für hybride Suche (BM25-ähnlich mit `ts_rank_cd`)
- `chat_sessions` / `chat_messages` inkl. der jeweils verwendeten Chunk-IDs
- `ingestion_jobs` für eine persistente Queue mit Wiederaufnahme
