# 006 – Embedding-Provider (Interface, Ollama-Adapter, Dimensionsprüfung)

## Kontext

RAGLab ist eine self-hosted RAG-Workbench (Fastify-API, Angular-Web, PostgreSQL + pgvector).
Mit 003–005 werden Dokumente hochgeladen, normalisiert und deterministisch gechunkt; Chunks liegen mit
`embedding = NULL` in der DB, und Dokumente stehen als Zwischenstand auf `ready`.

Dieser Prompt führt die provider-neutrale Embedding-Abstraktion ein, implementiert den Ollama-Adapter
per `fetch`, hängt einen Embedding-Schritt in den Indexer und stellt sicher, dass Konfiguration,
Provider-Ausgabe, Collection und DB-Spalte dieselbe Dimension bzw. dasselbe Modell verwenden.

**Voraussetzungen:** 002–005 erledigt. Ollama läuft nativ auf dem Host; ein Embedding-Modell
(Beispiel: `nomic-embed-text`, 768 Dimensionen) muss **vom Benutzer** gezogen werden. Lade selbst keine
Modelle herunter.

## Zuerst untersuchen

- `docs/architecture.md` §5 (Interface `EmbeddingProvider`, Dimensionsprüfung), §7; ADR 0002 §3.
- `apps/api/src/config/env.ts` (`EMBEDDING_PROVIDER` = `ollama`, `EMBEDDING_MODEL`,
  `EMBEDDING_DIMENSIONS` ≤ `MAX_INDEXABLE_VECTOR_DIMENSIONS`, `OLLAMA_BASE_URL`).
- `src/db/schema.ts` (Spaltendimension), `src/db/probe.ts` (Readiness inkl. Schema-Check aus 003).
- Indexer + Chunking-Schritt aus 004/005; `collections`-Felder `embedding_provider/model/dimensions`.
- Ollama-API-Doku für `POST /api/embed` (Request `{ model, input: string[] }`, Response
  `{ embeddings: number[][] }`) und `GET /api/tags` – nicht aus dem Gedächtnis annehmen, prüfen.

## Ziele

1. Interface `EmbeddingProvider` (`id`, `model`, `dimensions`, `embed(texts, signal?)`) wie in
   `docs/architecture.md` §5.
2. `OllamaEmbeddingProvider` mit Batching, Timeout, Abbruch per `AbortSignal`, klaren Fehlern.
3. Factory `createEmbeddingProvider(config)` – einzige Stelle, die Provider-IDs kennt.
4. Dimensionsprüfung jeder Antwort; Modell-/Dimensions-Abgleich mit der Collection.
5. Indexierungsschritt „embedding“: Vektoren für alle Chunks des Dokuments speichern; `ready` erst
   danach (Zwischenstand aus 005 entfällt).
6. `POST /api/documents/:id/reindex` für `failed` und für Dokumente mit fehlenden Embeddings.
7. Provider-Status sichtbar machen: `GET /api/system/providers`.

## Umsetzung (Vorschlag)

**Modul `embeddings`** – `apps/api/src/modules/embeddings/`
- `embedding-provider.ts`: Interface + Fehlerklasse `EmbeddingProviderError` mit `code`
  (`PROVIDER_UNREACHABLE`, `MODEL_NOT_FOUND`, `DIMENSION_MISMATCH`, `PROVIDER_TIMEOUT`, `PROVIDER_ERROR`).
- `ollama-embedding-provider.ts`: `fetch(`${baseUrl}/api/embed`)`, Batches à `EMBEDDING_BATCH_SIZE`,
  Timeout `EMBEDDING_TIMEOUT_MS` (kombiniert mit externem Signal via `AbortSignal.any`), HTTP 404/
  „model not found“ → `MODEL_NOT_FOUND` mit Hinweis `ollama pull <model>`. Anzahl der Vektoren muss
  der Anzahl der Eingaben entsprechen.
- `create-embedding-provider.ts`: Auswahl nach `config.embedding.provider`.
- `embedding.step.ts`: lädt Chunks ohne Embedding, bettet in Batches ein, schreibt Vektoren
  (Transaktion pro Dokument oder pro Batch – entscheiden, Konsistenz begründen).
- Vor dem Einbetten: Collection-Modell/-Dimension == Provider-Modell/-Dimension, sonst Dokument
  `failed` mit `EMBEDDING_MODEL_MISMATCH`-Meldung (keine stille Mischung von Modellen).

**Provider-Status** – `src/modules/system/providers.routes.ts`
- `GET /api/system/providers` → pro Provider: `reachable`, `modelAvailable` (über `/api/tags`),
  `dimensions: { configured, column, verified? }`. Eine Test-Einbettung nur auf ausdrücklichen
  Wunsch (`?verify=true`), da sie Rechenzeit kostet.
- Entscheide und dokumentiere, ob ein nicht erreichbarer Provider die Readiness auf `not_ready` setzt
  (Empfehlung: nein – UI und Collections bleiben nutzbar; Dimensionsabweichung Config↔Spalte bleibt
  `not_ready`, siehe 003).

**Reindex** – `POST /api/documents/:id/reindex` → `202`; erlaubt aus `failed` und `ready`
(mit fehlenden Embeddings); bei `processing` → `409 DOCUMENT_BUSY`.

**Konfiguration:** `EMBEDDING_BATCH_SIZE` (z. B. 32), `EMBEDDING_TIMEOUT_MS` (z. B. 60000) in
`env.ts` und `.env.example`.

**Test-Fakes** – `apps/api/test/fakes/fake-embedding-provider.ts`: deterministische Vektoren
(z. B. Hash-basiert, normiert) mit konfigurierbarer Dimension und optionalen Fehlern. Fakes liegen
im Testcode, nicht im Produktionscode.

**Optional (nur wenn Zeit bleibt, klar getrennt):** OpenAI-kompatibler Adapter
(`EMBEDDING_PROVIDER=openai-compatible`, `EMBEDDING_API_BASE_URL`, `EMBEDDING_API_KEY`) – Key nur aus
Umgebungsvariablen, nie geloggt, nie in `/api/system/*` ausgegeben. Andernfalls in der Doku als
geplant markieren.

## Nicht im Umfang

- Retrieval/Suche (007), Chat-Provider (008).
- Mehrere Embedding-Modelle parallel (`chunk_embeddings`), `halfvec`, automatische Migration bei
  Dimensionswechsel.
- Modelldownload oder -verwaltung durch RAGLab.
- Persistente Job-Queue.

## Akzeptanzkriterien

- [ ] Mit laufendem Ollama und vorhandenem Modell: Upload → Chunks mit Embedding → Status `ready`.
- [ ] Ollama nicht erreichbar / Modell fehlt → Dokument `failed` mit verständlicher Meldung inkl. Hinweis;
      kein Prozessabsturz; Reindex funktioniert danach.
- [ ] Vektor mit falscher Länge wird nie gespeichert (`DIMENSION_MISMATCH`), kein Abschneiden/Auffüllen.
- [ ] Collection mit anderem Modell als der aktuelle Provider → Indexierung verweigert.
- [ ] Kein Provider-Name außer in der Factory und den Adaptern hartcodiert.
- [ ] `GET /api/system/providers` liefert ehrliche Werte (nichts „verifiziert“, was nicht geprüft wurde).
- [ ] `pnpm test` und CI laufen ohne Ollama.

## Tests

- Unit: Ollama-Adapter gegen gemocktes `fetch` (Erfolg, Batching-Grenzen, 404/Modell fehlt,
  Netzwerkfehler, Timeout, Abbruch, falsche Vektorlänge, falsche Vektoranzahl); Factory;
  Embedding-Schritt mit Fake-Provider und Fake-Repository; Modell-Mismatch.
- Route-Tests: `/api/system/providers`, `/api/documents/:id/reindex` (Statusregeln).
- Integration: Upload → Indexer mit Fake-Provider (Dimension 768) → Vektoren in `chunks.embedding`,
  `vector_dims(embedding)` korrekt; Reindex nach Fehler.
- Optional, nicht in CI: `test/live/ollama.live.test.ts`, nur aktiv mit `RAGLAB_LIVE_TESTS=1`.

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build && pnpm format:check
```

## Dokumentation & Abschluss

- `docs/architecture.md` §5 (tatsächliche Umsetzung), §7, Modultabelle, §9 (Zwischenstand aus 005 entfernen).
- README: Ollama-Setup (`ollama pull nomic-embed-text` als Anleitung für Benutzer), Fehlerbehebung.
- `.env.example`: neue Variablen; ADR 0002 §3 bei Abweichungen.
- Abschlussbericht gemäß 002; Datei nach `prompts/done/`. Nächster Prompt: `007-vector-retrieval.md`.
