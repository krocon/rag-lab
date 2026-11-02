# 007 – Vector Retrieval (pgvector-Suche, Collection-Filter, Top-K, Scores)

## Kontext

RAGLab ist eine self-hosted RAG-Workbench (Fastify-API, Angular-Web, PostgreSQL + pgvector).
Mit 003–006 werden Dokumente hochgeladen, gechunkt und über einen austauschbaren
`EmbeddingProvider` (Ollama) eingebettet; Vektoren liegen in `chunks.embedding` mit HNSW-Index
(`vector_cosine_ops`).

Dieser Prompt baut den **Retrieval-Service**, den später Chat (008), Playground (011),
Evaluierung (013) und MCP-Server (014) gemeinsam nutzen, sowie `POST /api/retrieval/search`.

**Voraussetzungen:** 002–006 erledigt.

## Zuerst untersuchen

- ADR 0002 §4 (verbindlich: Metrik, Felder, Filter, `hnsw.iterative_scan`), `docs/data-model.md`
  „Distanz und Score“, `docs/architecture.md` §3 (Regel: Chat und Playground nutzen denselben Service).
- `apps/api/test/integration/database.int.test.ts` (bestätigt `<=>` als Cosinus-Distanz).
- `src/db/schema.ts`, Embedding-Modul (Provider, Factory, Fehlerklassen), Collections-Service
  (Embedding-Modell der Collection), `config.retrieval.defaultTopK` (`RETRIEVAL_TOP_K`, max 100).
- pgvector-Doku zu `hnsw.iterative_scan`, `hnsw.ef_search` und Drizzle-Helfern (`cosineDistance`).
  Prüfe, ob `SET LOCAL` innerhalb einer Drizzle-Transaktion funktioniert.

## Ziele

1. `createRetrievalService({ db/repository, embeddingProvider, collections, config })` mit
   `search(request, signal?)`.
2. Metrik-Definition an **einer** Stelle: Operator `<=>`, Opclass `vector_cosine_ops`,
   `score = 1 - distance`.
3. Collection-Filter **in derselben SQL-Abfrage** vor `ORDER BY … LIMIT`; nur Chunks mit
   `embedding IS NOT NULL` von Dokumenten mit Status `ready`.
4. `SET LOCAL hnsw.iterative_scan = relaxed_order` in einer Transaktion, damit Filter nicht zu wenigen
   Treffern führen; Ergebnisse danach in der Anwendung stabil nach `distance` sortieren (relaxed_order
   kann leicht ungeordnet liefern).
5. Saubere Behandlung von leerer Collection, keinen Treffern, `minScore`-Filter, Modell-Mismatch.
6. Endpunkt `POST /api/retrieval/search`.

## Umsetzung (Vorschlag)

**Modul `retrieval`** – `apps/api/src/modules/retrieval/`
- `similarity.ts`: Konstanten/Helfer (`DISTANCE_OPERATOR`, `toScore(distance)`), dokumentiert.
- `retrieval.repository.ts`: Abfrage (Drizzle oder parametrisiertes SQL, **keine** String-Konkatenation
  mit Benutzerwerten) – Join auf `documents` für `filename`, Auswahl:
  `chunkId, documentId, chunkIndex, content, headingPath, startOffset, endOffset, distance`.
- `retrieval.service.ts`:
  - Collection laden (`404 COLLECTION_NOT_FOUND`).
  - Collection-Modell/-Dimension ≠ Provider → `409 EMBEDDING_MODEL_MISMATCH` mit `details`
    (`collectionModel`, `providerModel`) – Suche mit anderem Modell ist fachlich falsch.
  - Frage einbetten (Provider-Fehler → `502 EMBEDDING_PROVIDER_ERROR` bzw. `503` wenn unerreichbar;
    entscheiden und dokumentieren).
  - `topK` Standard aus Konfiguration, Bereich 1–100; `minScore` optional (−1…1).
  - Ergebnis inkl. `rank` (1-basiert), Zeitmessung (`embeddingMs`, `searchMs`).
- `retrieval.routes.ts`: `POST /api/retrieval/search`.

**Vertrag (Shared Types `packages/shared/src/retrieval.ts`)**

```ts
interface RetrievalSearchRequest { collectionId: string; query: string; topK?: number; minScore?: number }
interface RetrievalResult {
  rank: number; chunkId: string; documentId: string; filename: string; chunkIndex: number;
  headingPath: string[]; content: string; startOffset: number; endOffset: number;
  distance: number; // cosine distance from `<=>`, 0..2, lower = more similar
  score: number;    // 1 - distance, higher = more similar
}
interface RetrievalSearchResponse {
  collectionId: string; query: string; topK: number; minScore: number | null;
  embedding: { provider: string; model: string; dimensions: number };
  results: RetrievalResult[];
  emptyReason?: 'collection_empty' | 'no_indexed_chunks' | 'below_min_score';
  timings: { embeddingMs: number; searchMs: number };
}
```

- `query`: getrimmt, 1–`MAX_QUERY_CHARS` Zeichen (neue Variable, z. B. 2000).
- Leeres Ergebnis ist **kein** Fehler: `200` mit `results: []` und `emptyReason`.

## Nicht im Umfang

- Hybride Suche (`tsvector`/BM25), Reranking, MMR/Diversifizierung, Query-Rewriting.
- Suche über mehrere Collections gleichzeitig.
- Chat und Prompt-Aufbau (008), Playground-Diagnose und UI (011).
- Caching von Query-Embeddings.

## Akzeptanzkriterien

- [ ] Ergebnisse stammen ausschließlich aus der angefragten Collection – auch wenn eine andere
      Collection viel ähnlichere Chunks enthält (Test!).
- [ ] Mit HNSW-Index und Filter liefert die Suche bis zu `topK` Treffer, wenn genügend passende
      Chunks existieren (Test mit vielen Chunks in einer fremden Collection).
- [ ] `distance` und `score` sind korrekt benannt und berechnet (`score = 1 - distance`), sortiert nach
      aufsteigender Distanz, `rank` lückenlos.
- [ ] Chunks ohne Embedding und Dokumente ≠ `ready` werden ignoriert.
- [ ] Leere Collection / keine Treffer / alle unter `minScore` → `200`, `results: []`, passender `emptyReason`.
- [ ] Modell-Mismatch → `409 EMBEDDING_MODEL_MISMATCH`; ungültige Parameter → `400 VALIDATION_ERROR`.
- [ ] Endpunkt in OpenAPI; Felder `distance`/`score` dort beschrieben.
- [ ] Keine Dokumentinhalte oder Queries im Info-Log (Debug-Level nur gekürzt, begründen).

## Tests

- Unit: `toScore`, Validierung, Service mit Fake-Repository und Fake-Provider (Mismatch, Leerfälle,
  `minScore`, Sortierung nach relaxed_order-Ergebnis, Provider-Fehler).
- Integration (`test/integration/retrieval.int.test.ts`): Chunks mit **handkonstruierten Vektoren**
  (z. B. Einheitsvektoren in 768 Dimensionen) direkt einfügen, Fake-Provider liefert bekannte
  Query-Vektoren → exakte erwartete Reihenfolge und Distanzen (`toBeCloseTo`); Collection-Isolation;
  Ignorieren von `NULL`-Embeddings und nicht-`ready`-Dokumenten; Prüfung, dass `SET LOCAL` nur innerhalb
  der Transaktion gilt.
- Route-Test mit `app.inject()` für Fehlerformate.

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build && pnpm format:check
```

Manuell (mit Ollama): `curl -X POST localhost:3000/api/retrieval/search -H 'content-type: application/json' -d '{"collectionId":"…","query":"…"}'`.

## Dokumentation & Abschluss

- ADR 0002 §4 und `docs/data-model.md` „Distanz und Score“ mit der tatsächlichen Umsetzung abgleichen
  (z. B. Umgang mit `relaxed_order`, `ef_search`).
- `docs/architecture.md` Modultabelle, §4.2 Schritt 2, §9; README (Such-Beispiel); `.env.example`.
- Abschlussbericht gemäß 002; Datei nach `prompts/done/`. Nächster Prompt: `008-rag-chat-streaming.md`.
