# 005 – Chunking-Pipeline (deterministisch, mit Herkunftsmetadaten)

## Kontext

RAGLab ist eine self-hosted RAG-Workbench (Fastify-API, Angular-Web, PostgreSQL + pgvector).
Mit 003/004 können Collections angelegt und Markdown/TXT hochgeladen werden; der normalisierte Text
liegt in `documents.content`, ein Indexer-Gerüst mit `IndexingStep`-Schnittstelle existiert,
aber es gibt noch keine Schritte – Dokumente bleiben `pending`.

Dieser Prompt implementiert den deterministischen, zeichenbasierten Chunker aus ADR 0002 und hängt ihn
als ersten Indexierungsschritt ein. Chunks werden mit Offsets und Überschriftenpfad gespeichert,
`embedding` bleibt `NULL` (Embeddings folgen in 006).

**Voraussetzungen:** 002, 003, 004 erledigt.

## Zuerst untersuchen

- `docs/adr/0002-rag-pipeline.md` §2 (verbindliche Regeln und Garantien), `docs/data-model.md` (`chunks`).
- `apps/api/src/config/env.ts`: `CHUNK_SIZE` (1200), `CHUNK_OVERLAP` (200), Refinement
  `CHUNK_OVERLAP < CHUNK_SIZE`; `AppConfig.chunking`.
- Ergebnis von 004: `document-indexer.ts`, `IndexingStep`, Repository-Funktionen, Statuslogik.
- Prüfe, ob es bereits Hilfsfunktionen (z. B. Satzgrenzen) gibt, bevor du neue schreibst.
  Keine externe Chunking-Bibliothek ohne starke Begründung (Determinismus, Offsets).

## Ziele

1. Reine Funktion `chunkText(text, options): ChunkDraft[]` ohne I/O, vollständig getestet.
2. Hierarchische Trennung: Markdown-Überschriften → Absätze (`\n\n`) → Sätze → Wortgrenze → hart.
3. Overlap an Wort-/Satzgrenze ausgerichtet, nie mitten im Wort.
4. Herkunftsmetadaten: `chunkIndex`, `startOffset`, `endOffset` (bezogen auf den normalisierten Text),
   `charCount`, `tokenEstimate` (≈ Zeichen/4, nur informativ), `headingPath`.
5. Chunking-Schritt im Indexer: Chunks in **einer Transaktion** speichern, `chunk_count` setzen.
6. Endpunkt zur Inspektion: `GET /api/documents/:id/chunks`.

## Umsetzung (Vorschlag)

**Modul `chunking`** – `apps/api/src/modules/chunking/`
- `chunker.ts`:
  ```ts
  interface ChunkingOptions { targetSize: number; overlap: number; format: 'markdown' | 'text' }
  interface ChunkDraft {
    chunkIndex: number; content: string; startOffset: number; endOffset: number;
    charCount: number; tokenEstimate: number; headingPath: string[];
  }
  ```
- `markdown-sections.ts`: ATX-Überschriften (`#`–`######`) erkennen, Überschriften in Codeblöcken
  (```` ``` ````/`~~~`) ignorieren, Überschriftenpfad als Stack pflegen. Setext-Überschriften: entscheiden
  und dokumentieren.
- `boundaries.ts`: Absatz-, Satz- (`.`, `!`, `?`, gefolgt von Whitespace; einfache Heuristik, Grenzen
  dokumentieren) und Wortgrenzen.
- Abschnitte, die kleiner als `targetSize` sind, dürfen innerhalb desselben Überschriftenabschnitts
  zusammengefasst werden (entscheiden, dokumentieren). Chunks überschreiten `targetSize` nur, wenn
  ein einzelnes Wort länger ist (dann harter Schnitt).
- `content` ist exakt `text.slice(startOffset, endOffset)` – ggf. nach Trimmen von Rand-Whitespace,
  wobei die Offsets mitgeführt werden. Diese Invariante wird getestet.
- `chunking.step.ts`: `IndexingStep` „chunking“ – liest `documents.content`, chunkt mit
  `config.chunking`, löscht vorhandene Chunks des Dokuments und schreibt neue (Transaktion).

**Statussemantik bis 006:** Nach erfolgreichem Chunking setzt der Indexer `ready`; Chunks haben
`embedding = NULL`. Das wird in `docs/architecture.md` §9 und README ausdrücklich als Zwischenstand
benannt („ready = gechunkt, Embeddings folgen mit 006“). Retrieval (007) berücksichtigt nur Chunks mit
`embedding IS NOT NULL`.

**API**
- `GET /api/documents/:id/chunks` → `{ documentId, chunks: ChunkDto[] }`, sortiert nach `chunkIndex`
  (inkl. `hasEmbedding: boolean`, ohne Vektor).
- Optional `POST /api/chunking/preview` (`{ text, format, targetSize?, overlap? }`) für den späteren
  Playground – nur, wenn mit wenig Code sauber machbar; Eingabelänge begrenzen.

**Shared Types:** `ChunkDto`, `DocumentChunksResponse` (und ggf. Preview-Typen).

## Nicht im Umfang

- Embeddings (006), Suche (007).
- Semantisches oder tokenbasiertes Chunking, modellspezifische Tokenizer, Code-Parser.
- Pro-Collection-Chunking-Konfiguration (später; Konfiguration ist global).
- Re-Chunking bestehender Dokumente bei Konfigurationsänderung (dokumentieren als offen).
- UI (009/011).

## Akzeptanzkriterien

- [ ] Keine leeren oder reinen Whitespace-Chunks; `chunkIndex` lückenlos ab 0.
- [ ] Gleiche Eingabe + gleiche Optionen → identische Ausgabe (Determinismus).
- [ ] Für jeden Chunk gilt `text.slice(startOffset, endOffset)` ergibt `content` (bzw. die dokumentierte
      Trim-Variante); Offsets monoton steigend.
- [ ] Die Konkatenation der Chunks ohne Overlap-Anteil rekonstruiert den Text (bis auf dokumentierte
      Whitespace-Regeln); kein Text geht verloren.
- [ ] Kein Chunk beginnt oder endet mitten in einem Wort, außer bei dokumentiertem hartem Schnitt.
- [ ] Overlap ≤ `CHUNK_OVERLAP`, Chunkgröße ≤ `CHUNK_SIZE` (außer überlange Einzelwörter).
- [ ] Überschriftenpfad korrekt, auch über Ebenen-Sprünge (`#` → `###`) und mit `#` in Codeblöcken.
- [ ] Nach Upload landen Chunks in der DB, `documents.chunk_count` stimmt, Status `ready`.
- [ ] Fehler im Chunking → Dokument `failed` mit verständlicher Meldung, keine halben Chunk-Sätze.

## Tests

- Unit (`apps/api/test/chunking/*.test.ts`): Tabellen-Tests für kurze Texte, Text ohne Absätze,
  sehr langes Wort, nur Überschriften, verschachtelte Überschriften, Codeblöcke, Unicode (Emoji,
  Umlaute – Offsets in UTF-16-Codeunits konsistent mit `String.prototype.slice`), Overlap = 0,
  Overlap knapp unter `targetSize`.
- Eigenschaftsbasierte Tests (generierte Texte, fester Seed; eine kleine eigene Generatorfunktion
  genügt – neue Abhängigkeit wie `fast-check` nur mit Begründung) für die Invarianten oben.
- Golden-Test: Fixture `test/fixtures/chunking/sample.md` mit eingecheckter erwarteter Ausgabe
  (JSON), um unbeabsichtigte Verhaltensänderungen sichtbar zu machen.
- Integration: Upload → Chunks in der DB, Transaktion bei Fehler (keine Teilmenge), Endpunkt
  `/api/documents/:id/chunks`.

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build && pnpm format:check
```

## Dokumentation & Abschluss

- ADR 0002 §2: tatsächliche Regeln, Heuristiken und Trade-offs ergänzen (nicht widersprechen; bei
  Abweichung begründen).
- `docs/architecture.md` Modultabelle (`chunking` implementiert), §4.1, §9 inkl. Zwischenstand-Hinweis.
- `docs/data-model.md`: Nutzung von `heading_path`, `metadata`, `token_estimate`.
- Abschlussbericht gemäß 002; Datei nach `prompts/done/`. Nächster Prompt: `006-embedding-providers.md`.
