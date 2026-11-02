# RAGLab – Datenmodell

Stand: 2026-11-02 · **Zielmodell.** Implementiert ist bisher nur Migration `0000_enable_pgvector`;
die Tabellen unten werden mit [prompts/003-database-domain-model.md](../prompts/003-database-domain-model.md)
angelegt. Abweichungen bei der Umsetzung sind hier nachzutragen.

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
| `created_at`, `updated_at` | `timestamptz` NOT NULL |                                                                             |

Das Embedding-Modell wird pro Collection festgehalten, damit ein späterer Modellwechsel erkannt
werden kann (Suche mit anderem Modell als bei der Indexierung ist fachlich falsch → Fehler bzw.
Re-Indexierung erforderlich).

### `documents`

| Spalte                     | Typ                             | Hinweise                                                                |
| -------------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| `id`                       | `uuid` PK                       |                                                                         |
| `collection_id`            | `uuid` FK → `collections`       | `ON DELETE CASCADE`, Index                                              |
| `filename`                 | `text` NOT NULL                 | Originalname, nur zur Anzeige (bereinigt)                               |
| `mime_type`                | `text` NOT NULL                 | `text/markdown` oder `text/plain`                                       |
| `size_bytes`               | `integer` NOT NULL              | Größe der Originaldatei                                                 |
| `content_sha256`           | `text` NOT NULL                 | Hash des normalisierten Texts; Unique `(collection_id, content_sha256)` |
| `content`                  | `text` NOT NULL                 | normalisierter Volltext (Basis für Re-Chunking und Quellenansicht)      |
| `status`                   | `document_status` NOT NULL      | Enum: `pending`, `processing`, `ready`, `failed`                        |
| `error_message`            | `text` NULL                     | nur bei `failed`, für Benutzer verständlich, ohne Stacktrace            |
| `chunk_count`              | `integer` NOT NULL DEFAULT 0    |                                                                         |
| `metadata`                 | `jsonb` NOT NULL DEFAULT `'{}'` | z. B. Titel aus erster Überschrift                                      |
| `created_at`, `updated_at` | `timestamptz` NOT NULL          |                                                                         |

Statusübergänge: `pending → processing → ready | failed`; `failed → processing` bei erneutem Versuch.

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
| `token_estimate`             | `integer` NULL                   | grobe Schätzung, nur informativ                                                 |
| `heading_path`               | `text[]` NOT NULL DEFAULT `'{}'` | z. B. `{"Installation","Docker"}` (Markdown)                                    |
| `metadata`                   | `jsonb` NOT NULL DEFAULT `'{}'`  | erweiterbar (z. B. Seitenzahl bei späteren Formaten)                            |
| `embedding`                  | `vector(768)` NULL               | NULL bis eingebettet; Dimension = `EMBEDDING_DIMENSIONS`                        |
| `created_at`, `updated_at`   | `timestamptz` NOT NULL           |                                                                                 |

Indizes:

- `chunks (collection_id)` – Filter
- HNSW: `CREATE INDEX … ON chunks USING hnsw (embedding vector_cosine_ops)` – passend zum
  Operator `<=>` (Cosinus-Distanz)
- `documents (collection_id, status)`

## Embedding-Dimension

Die Dimension steht an drei Stellen und muss übereinstimmen:

1. `EMBEDDING_DIMENSIONS` in der Konfiguration (validiert: 1–2.000),
2. die Spalte `chunks.embedding vector(n)` (Migration),
3. die tatsächliche Ausgabe des Modells.

Die API liest beim Readiness-Check die Spaltendimension aus dem Katalog
(`format_type(atttypid, atttypmod)` bzw. `atttypmod`) und vergleicht sie mit der Konfiguration.
Ein Modellwechsel mit anderer Dimension erfordert eine neue Migration (Spalte ändern, Index neu
bauen, Chunks neu einbetten). Über 2.000 Dimensionen: `halfvec` (HNSW bis 4.000) – bewusst nicht
im MVP.

## Distanz und Score

Gespeichert und abgefragt wird **Cosinus-Distanz** (`embedding <=> query`, Bereich 0–2, kleiner ist
ähnlicher). Die API liefert beide Werte eindeutig benannt:

- `distance` = Rohwert des Operators,
- `score` = `1 - distance` (Cosinus-Ähnlichkeit, −1…1, größer ist ähnlicher).

## Erweiterungen (nicht MVP)

- `chunk_embeddings (chunk_id, model, dimensions, embedding)` für mehrere Modelle/A-B-Vergleiche
- `tsvector`-Spalte + GIN-Index für hybride Suche (BM25-ähnlich mit `ts_rank_cd`)
- `chat_sessions` / `chat_messages` inkl. der jeweils verwendeten Chunk-IDs
- `ingestion_jobs` für eine persistente Queue mit Wiederaufnahme
