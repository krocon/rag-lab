# 004 – Document Ingestion (Upload, Extraktion, Normalisierung, Status)

## Kontext

RAGLab ist eine self-hosted RAG-Workbench (Fastify-API, Angular-Web, PostgreSQL + pgvector).
Mit 003 existieren die Tabellen `collections`, `documents`, `chunks`, das Fehlerformat
`{ error: { code, message, details? } }` und lesende Dokument-Endpunkte. Es gibt noch keinen Upload.

Dieser Prompt implementiert den Upload von Markdown/TXT, Textextraktion und Normalisierung,
Duplikaterkennung sowie das Statusmodell und das Gerüst der asynchronen Indexierung.

**Voraussetzungen:** 002, 003 erledigt (siehe `prompts/done/`).

## Zuerst untersuchen

- `docs/architecture.md` §4.1 (Indexierungsablauf, `202 Accepted`, Recovery beim Start), §7, §8.
- `docs/adr/0002-rag-pipeline.md` §1 (Formate, Normalisierungsregeln, SHA-256).
- `docs/data-model.md` (`documents`, Statusübergänge).
- Ergebnis von 003: `src/modules/documents/`, Error-Helfer, `buildApp`-Verdrahtung, Shared Types.
- `apps/api/src/app.ts`: globales `bodyLimit` (1 MiB) – Upload braucht eigene Limits.
- Aktuelle Version von `@fastify/multipart` per `npm view` prüfen.

## Ziele

1. `POST /api/collections/:id/documents` (multipart, eine oder mehrere Dateien) → `202 Accepted`.
2. Validierung: Allowlist `.md`, `.markdown`, `.txt`; Größenlimit; striktes UTF-8; nicht leer.
3. Normalisierung gemäß ADR 0002 als **reine, getestete Funktion**.
4. SHA-256 des normalisierten Texts, Duplikat pro Collection → `409`.
5. Statusmodell `pending → processing → ready | failed` mit verständlicher `error_message`.
6. Asynchroner Indexer im API-Prozess mit Schritt-Schnittstelle (Chunking/Embedding folgen in 005/006).
7. Recovery: Dokumente in `processing` werden beim Start auf `failed` gesetzt (mit Hinweis).

## Umsetzung (Vorschlag)

**Modul `ingestion`** – `apps/api/src/modules/ingestion/`
- `normalize.ts`: `normalizeText(raw: string): string` – BOM entfernen, `\r\n`/`\r` → `\n`, Unicode NFC,
  Steuerzeichen außer `\n`/`\t` entfernen, mehr als zwei Leerzeilen zusammenfassen, kein sonstiges
  Umschreiben des Inhalts.
- `decode.ts`: `decodeUtf8(bytes)` mit `new TextDecoder('utf-8', { fatal: true })`; NUL-Bytes → als
  Binärdatei ablehnen.
- `file-type.ts`: Allowlist nach Endung; MIME-Typ wird **abgeleitet** (`text/markdown`, `text/plain`),
  nicht vom Client übernommen. Dateiname bereinigen (Pfadanteile, Steuerzeichen entfernen, Länge begrenzen).
- `hash.ts`: SHA-256 (hex) via `node:crypto`.
- `metadata.ts`: Titel aus erster Markdown-Überschrift → `documents.metadata.title` (optional).

**Upload-Route** – `src/modules/documents/documents.routes.ts`
- `@fastify/multipart` nur für diese Route bzw. mit Limits: `fileSize = MAX_UPLOAD_BYTES`,
  `files = MAX_UPLOAD_FILES`; Überschreitung → `413 FILE_TOO_LARGE`.
- Ablauf je Datei: Typ prüfen → Bytes lesen → dekodieren → normalisieren → leer? → Hash → Duplikat? →
  `documents` mit `status = 'pending'`, `content`, `size_bytes`, `content_sha256` speichern →
  Indexer anstoßen (nicht awaiten).
- Antwort `202` mit `{ documents: DocumentDto[] }`. Bei mehreren Dateien: Entscheide und dokumentiere,
  ob ein Fehler die ganze Anfrage abbricht (empfohlen: alles-oder-nichts-Validierung vor dem Speichern).
- Fehlercodes: `400 EMPTY_DOCUMENT`, `400 INVALID_ENCODING`, `400 NO_FILE`, `404 COLLECTION_NOT_FOUND`,
  `409 DUPLICATE_DOCUMENT` (`details.existingDocumentId`), `413 FILE_TOO_LARGE`, `415 UNSUPPORTED_FILE_TYPE`.
- `GET /api/documents/:id/content` → `{ documentId, content }` (normalisierter Text, Basis für Quellenansicht).

**Indexer** – `src/modules/ingestion/document-indexer.ts`
- `createDocumentIndexer({ repository, steps, logger })` mit `index(documentId): Promise<void>`;
  `IndexingStep`-Interface (`name`, `run(context, signal)`).
- Setzt `processing`, führt Schritte aus, setzt am Ende `ready` (inkl. `chunk_count`) oder `failed` mit
  benutzerverständlicher Meldung; Stacktraces nur ins Log (ohne Dokumentinhalt).
- Begrenzte Parallelität (`INGESTION_CONCURRENCY`, Standard 2), Shutdown wartet auf laufende Jobs
  oder bricht per `AbortSignal` ab (`onClose`-Hook).
- **Ehrlicher Zwischenzustand:** Solange es keine Schritte gibt (vor 005), wird der Indexer nicht
  gestartet; Dokumente bleiben `pending`. Das wird in README/Architektur so benannt – kein künstliches `ready`.
- `src/modules/ingestion/recovery.ts`: beim Start `processing` → `failed`
  („Processing was interrupted by a server restart. Retry the upload.“).

**Konfiguration** (`env.ts`, `.env.example`): `MAX_UPLOAD_BYTES` (z. B. 5 MiB), `MAX_UPLOAD_FILES`
(z. B. 20), `INGESTION_CONCURRENCY`. Werte begründen.

**Shared Types:** `UploadDocumentsResponse`, `DocumentContentResponse`, ggf. `DocumentDto.metadata`.

## Nicht im Umfang

- Chunking (005), Embeddings (006), Retry-/Reindex-Endpunkt (006).
- PDF, DOCX, HTML, OCR, URL-Import, Git-Sync, ZIP-Upload.
- Persistente Job-Queue (`ingestion_jobs`), Worker-Prozess.
- Rate Limits und weitere Härtung (012) – aber keine offensichtlichen Lücken lassen.
- UI (009).

## Akzeptanzkriterien

- [ ] `.md`/`.txt`-Upload liefert `202`, Dokument steht mit normalisiertem `content`, korrektem Hash,
      `size_bytes` und `mime_type` in der DB.
- [ ] `.pdf`, `.exe`, Datei mit falscher Endung → `415`; ungültiges UTF-8 bzw. NUL-Bytes → `400`;
      zu groß → `413`; leer/nur Whitespace → `400`; gleicher Inhalt in derselben Collection → `409`,
      in anderer Collection erlaubt.
- [ ] CRLF- und LF-Variante desselben Texts ergeben denselben Hash (Duplikat).
- [ ] Unbekannte Collection → `404` im Fehlerformat.
- [ ] Indexer-Gerüst setzt Status korrekt (mit Fake-Schritten getestet), `failed` enthält eine
      verständliche Meldung ohne Stacktrace.
- [ ] Nach Neustart gibt es keine Dokumente in `processing`.
- [ ] Logs enthalten keine Dokumentinhalte.
- [ ] Route in OpenAPI dokumentiert (multipart).

## Tests

- Unit: `normalizeText` (BOM, CRLF, NFC vs. NFD, Steuerzeichen, Leerzeilen, Idempotenz:
  `normalize(normalize(x)) === normalize(x)`), `decodeUtf8`, Dateinamen-Bereinigung, Allowlist,
  Indexer mit Fake-Repository und Fake-Schritten (Erfolg, Fehler, Abbruch).
- Route-Tests mit `app.inject()` und multipart-Payloads (z. B. via `form-data`/`FormData`) für alle
  Fehlercodes.
- Integration (`test/integration/documents-upload.int.test.ts`): Upload → DB-Inhalt, Duplikat,
  Recovery-Funktion, Cascade beim Löschen.

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build && pnpm format:check
```

Manuell: `curl -F "file=@README.md" http://localhost:3000/api/collections/<id>/documents`.

## Dokumentation & Abschluss

- `docs/architecture.md` §4.1 an die Umsetzung anpassen, Modultabelle (`ingestion`, `documents`), §9.
- `docs/data-model.md`: Abweichungen (z. B. Metadaten-Felder).
- README: Upload-Beispiel, Limits; `.env.example`: neue Variablen.
- Abschlussbericht gemäß 002; Datei nach `prompts/done/`. Nächster Prompt: `005-chunking-pipeline.md`.
