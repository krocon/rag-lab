# 011 – Retrieval Playground (Suchdiagnose, Scores, Chunk-Vorschau)

## Kontext

RAGLab ist eine self-hosted RAG-Workbench mit Schwerpunkt **Transparenz der RAG-Pipeline**.
Nach 007 gibt es einen gemeinsamen Retrieval-Service (`POST /api/retrieval/search`, Felder
`distance` = Cosinus-Distanz aus `<=>` und `score = 1 - distance`), nach 008 einen Chat, der denselben
Service nutzt, nach 009/010 Knowledge-Base- und Chat-UI.

Dieser Prompt baut das `playground`-Backendmodul (Diagnose-Daten) und die Oberfläche unter
`/playground`, mit der Entwickler genau sehen, was der Chat für eine Frage abrufen würde.

**Voraussetzungen:** 002–010 erledigt (Backend-Teil braucht nur 007/008).

## Zuerst untersuchen

- `docs/architecture.md` §3 (Regel: Playground und Chat nutzen **denselben** Retrieval-Service),
  ADR 0002 §4/§5, `docs/data-model.md` „Distanz und Score“.
- `apps/api/src/modules/retrieval/` und `chat/prompt-builder.ts` (Kontextbudget, Quellenauswahl).
- `apps/web/src/app/features/` (Muster aus 009/010), API-Client, Chunk-Deep-Link der Dokumentansicht.
- `packages/shared/src/retrieval.ts`, `chat.ts`.
Entscheide, ob ein eigener Endpunkt nötig ist oder `POST /api/retrieval/search` um Diagnosefelder
erweitert wird – begründen. Vorschlag unten.

## Ziele

**Backend – Modul `playground`** (`apps/api/src/modules/playground/`)
1. `POST /api/playground/search` mit Body `{ collectionId, query, topK?, minScore?, includePrompt? }`.
   Nutzt den Retrieval-Service unverändert und ergänzt Diagnose-Daten:
   - `results` (wie Retrieval) plus pro Treffer `includedInChatContext: boolean` (würde der Chat ihn
     innerhalb von `CHAT_CONTEXT_CHAR_BUDGET` verwenden?) und `belowMinScore`,
   - `stats`: Anzahl indexierter Chunks der Collection, Chunks ohne Embedding, Dokumente nach Status,
   - `embedding`: Provider, Modell, Dimension (Collection vs. aktueller Provider),
   - `search`: Metrik `cosine`, Operator `<=>`, `iterativeScan`-Einstellung, `topK`, `minScore`,
   - `timings`: `embeddingMs`, `searchMs`,
   - optional `prompt` (bei `includePrompt: true`): die Nachrichten, die der Chat an das Modell senden
     würde (Ergebnis von `buildGroundedPrompt`, **ohne** LLM-Aufruf).
2. Keine zweite Suchimplementierung – Diagnose leitet sich aus denselben Funktionen ab wie der Chat.

**Frontend – `apps/web/src/app/features/playground/`**
3. Formular: Collection, Query (mehrzeilig), Top-K (1–100), optional `minScore`, Checkbox „Prompt
   anzeigen“. Zustand in Query-Parametern (`/playground?collection=…&q=…&topK=…`), damit Suchen
   teilbar und reproduzierbar sind.
4. Ergebnisliste/-tabelle: Rang, Score und Distanz (beide beschriftet, Tooltip/Erklärtext zur
   Interpretation), Balken für den Score **mit** Zahlenwert (nicht nur Farbe/Länge), Dateiname,
   Überschriftenpfad, Chunk-Index, Markierung „im Chat-Kontext“ / „außerhalb Budget“ / „unter minScore“.
5. Chunk-Vorschau: aufklappbar bzw. Detailbereich mit vollständigem Chunk-Text, Offsets, Link zur
   Dokumentansicht mit Chunk-Deep-Link.
6. Diagnose-Panel: Embedding-Modell/Dimension, Statistiken, Timings, Warnungen (z. B. Chunks ohne
   Embedding, Modell-Mismatch, leere Collection mit `emptyReason`).
7. Prompt-Vorschau (optional angefordert): Systemnachricht und Quellblöcke als Text, kopierbar.
8. Link „Im Chat fragen“ übernimmt Collection und Query nach `/chat`.

## Nicht im Umfang

- Vergleich mehrerer Konfigurationen nebeneinander, A/B von Modellen, Chunking-Parameter live ändern
  (ggf. als Idee dokumentieren; `POST /api/chunking/preview` aus 005 nur nutzen, falls vorhanden).
- Hybride Suche, Reranking, Visualisierung des Vektorraums (t-SNE/UMAP).
- Speichern von Playground-Sitzungen; Evaluierung (013).

## Akzeptanzkriterien

- [ ] Für dieselbe Collection/Query/Top-K liefern Playground und Chat (`sources`) dieselben Chunks in
      derselben Reihenfolge mit identischen Scores (Test).
- [ ] `includedInChatContext` entspricht exakt der Quellenauswahl des Prompt-Builders (Test).
- [ ] `distance` und `score` werden überall eindeutig benannt; Erklärtext im UI ist korrekt
      („score = 1 − cosine distance, higher is more similar“).
- [ ] Prompt-Vorschau ruft kein LLM auf (Test mit Fake-Chat-Provider, der bei Aufruf fehlschlägt).
- [ ] Leere Collection, keine Treffer, Modell-Mismatch und Provider-Fehler werden verständlich gezeigt.
- [ ] Query-Parameter stellen eine Suche nach Reload wieder her.
- [ ] Tastaturbedienbar, Tabelle semantisch, Status nicht nur farblich, Kontraste in beiden Themes.

## Tests

- API Unit: Playground-Service mit Fake-Retrieval/Fake-Prompt-Builder (Flags, Statistiken,
  `includePrompt`), Route-Tests inkl. Fehlerformat.
- API Integration: echte DB mit handkonstruierten Vektoren (Muster aus 007), Statistiken
  (Chunks ohne Embedding, Dokumentstatus), Konsistenz Playground ↔ Chat-Quellenauswahl.
- Web: Komponententests für Formular ↔ Query-Parameter, Ergebnisdarstellung inkl. Flags, Vorschau,
  Diagnose-Warnungen, Fehler- und Empty-States.

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build && pnpm format:check
```

## Dokumentation & Abschluss

- `docs/architecture.md` Modultabelle (`playground` implementiert), §9; README (Playground-Abschnitt,
  Interpretation von Score/Distanz).
- Shared Types `packages/shared/src/playground.ts`; OpenAPI vollständig.
- Abschlussbericht gemäß 002; Datei nach `prompts/done/`. Nächster Prompt: `012-security-and-hardening.md`.
