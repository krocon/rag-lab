# 010 – Angular Chat UI (Streaming, Quellenanzeige, Fehlerzustände)

## Kontext

RAGLab ist eine self-hosted RAG-Workbench. Das Backend bietet nach 008 `POST /api/chat` als
SSE-Stream mit den Events `sources` (vor dem ersten Token), `token`, `done`
(`answerStatus`, `citedSources`, `unknownCitations`) und `error`; Fehler vor Streambeginn kommen als
JSON im Format `{ error: { code, message, details? } }`. Mit 009 existieren Knowledge-Base-UI,
API-Client unter `apps/web/src/app/core/` und eine Dokumentansicht mit Chunk-Deep-Link
(`/knowledge-bases/:collectionId/documents/:documentId?chunk=<chunkId>`).

Dieser Prompt baut die Chat-Oberfläche unter `/chat`.

**Voraussetzungen:** 002–009 erledigt.

## Zuerst untersuchen

- `apps/web/src/app/core/api/` (Client, Fehler-Mapping), Features aus 009 (Komponentenmuster,
  Dialoge, Live-Regionen, Theme-Tokens), `app.routes.ts`, Shell-Navigation.
- `packages/shared/src/chat.ts` (Event- und Request-Typen) – exakt diese Typen verwenden.
- Backend: `apps/api/src/modules/chat/` (Event-Reihenfolge, Abbruchverhalten, Fehlercodes).
- `docs/architecture.md` §4.2 und §8 (Rendering, Prompt-Injection-Hinweis), ADR 0002 §5/§6.
- Wie der Angular-Dev-Proxy SSE durchreicht (keine Pufferung); ggf. Proxy-Option prüfen.

## Ziele

1. Route `/chat` (optional `/chat?collection=<id>`): Collection-Auswahl (nur Collections mit
   mindestens einem `ready`-Dokument auswählbar, andere mit Hinweis), Eingabefeld, Senden, Abbrechen.
2. SSE-Client auf Basis von `fetch` + `ReadableStream` (EventSource kann kein POST), robust gegen
   Frames, die über mehrere Chunks verteilt sind.
3. Gestreamte Antwortanzeige mit Tipp-Fortschritt; Abbruch-Button bricht den Request ab
   (`AbortController`) und markiert die Antwort als abgebrochen.
4. Quellen: Quellenkarten bzw. Seitenleiste mit Nummer `[n]`, Dateiname, Überschriftenpfad, Score
   (beschriftet als „score“, mit Erklärung), Textausschnitt; Link zur Dokumentansicht mit Chunk-Deep-Link.
5. Zitate `[n]` im Antworttext werden zu Links/Buttons, die die Quelle hervorheben – **nur** für
   Nummern, die in `sources` geliefert wurden; `unknownCitations` werden sichtbar als „unbekannte
   Quelle“ markiert, nicht verlinkt.
6. Zustände: leer (Anleitung), lädt, streamt, fertig, `no_sources` (eigene, klare Darstellung),
   Fehler vor Stream (Validierung, `404`, `409 EMBEDDING_MODEL_MISMATCH`), Fehler im Stream
   (`error`-Event), Netzwerkabbruch – jeweils mit verständlicher Meldung und „Erneut versuchen“.
7. Verlauf der aktuellen Sitzung im Speicher (Signals); „Neuer Chat“ leert ihn. Kein Server-Verlauf.
8. Dauerhafter, unaufdringlicher Hinweis: Antworten beruhen auf Dokumenten, können durch
   manipulierte Inhalte verfälscht sein – Quellen prüfen.

## Umsetzung (Vorschlag)

- `src/app/core/api/sse-client.ts`: `streamSse(url, body, signal): AsyncIterable<{ event, data }>`
  – Parser für `event:`/`data:`/Leerzeile, mehrzeilige `data`, Kommentarzeilen; reine Funktion
  `parseSseChunk` separat testbar.
- `src/app/core/api/chat-api.ts`: `streamChat(request, signal)` → typisierte Events; Nicht-2xx-Antwort
  vor Streambeginn → `ApiErrorResponse`.
- `src/app/features/chat/`: `chat.page.ts`, `chat-composer.component.ts`, `chat-message.component.ts`,
  `source-list.component.ts`, `citation-text.component.ts` (zerlegt Text in Segmente
  `text | citation`, kein `innerHTML`), `chat.store.ts` (Signals, ein Objekt pro Nachricht mit
  `status`, `tokens`, `sources`, `done`, `error`).
- Antworttext als reiner Text mit Zeilenumbrüchen. Markdown-Rendering nur, wenn sicher sanitisiert
  (Angular-Sanitizer, kein `bypassSecurityTrust*`) – sonst als offen dokumentieren.
- Tastatur: `Enter` sendet, `Shift+Enter` neue Zeile, `Escape` bricht ab (dokumentiert, sichtbar).
- Barrierefreiheit: Nachrichtenliste als `log`-Region mit gedrosselten Ankündigungen (nicht jedes
  Token vorlesen – Ankündigung bei Start/Ende), Fokusmanagement nach Senden, Quellen als Liste mit
  Überschriften, Zitat-Buttons mit zugänglichem Namen („Quelle 2: <Dateiname>“).
- Streaming-Updates performant (Tokens anhängen, kein Neurendern der ganzen Liste).

## Nicht im Umfang

- Persistente Chat-Sessions, Verlaufssuche, Export, Mehrrunden-Kontext für das Modell.
- Mehrere Collections pro Frage, Modell-Auswahl im UI, Feedback-Buttons.
- Retrieval Playground (011), Backend-Änderungen außer kleinen, getesteten Fixes (dokumentieren).

## Akzeptanzkriterien

- [ ] Mit Ollama: Frage stellen → Quellen erscheinen vor bzw. mit dem ersten Text → Antwort streamt →
      Zitate sind klickbar und führen zur richtigen Quelle/Chunk.
- [ ] Abbrechen beendet den Stream sofort, UI bleibt bedienbar, Backend-Log zeigt den Abbruch.
- [ ] `no_sources`, Fehler vor dem Stream, `error`-Event und Netzwerkabbruch sind jeweils
      unterscheidbar und verständlich dargestellt.
- [ ] Zitate auf nicht gelieferte Quellen werden nie verlinkt.
- [ ] Keine HTML-Injektion über Antwort oder Quelleninhalt möglich (Test mit `<img onerror>`-Inhalt).
- [ ] Vollständig per Tastatur bedienbar, Screenreader-Ankündigungen nicht pro Token.
- [ ] Prompt-Injection-Hinweis sichtbar.

## Tests

- Unit: `parseSseChunk` (geteilte Frames, mehrzeilige Daten, Kommentare, CRLF), `streamSse` mit
  gemocktem `fetch`/`ReadableStream`, Zitat-Segmentierung (gültige, unbekannte, mehrfache `[1, 3]`).
- Komponenten-/Store-Tests: Event-Reihenfolge → UI-Zustände, Abbruch, alle Fehlerpfade, Navigation
  per Zitat, HTML-Escaping.
- Manuelle Prüfung im Browser über den Dev-Proxy (Streaming wird nicht gepuffert).

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm format:check
pnpm dev   # manuell: Chat gegen lokale Ollama-Instanz
```

## Dokumentation & Abschluss

- `docs/architecture.md` §9 (Web: Chat), README (Chat-Nutzung, Hinweis zum Restrisiko).
- Abweichungen im Bericht und in den Docs festhalten.
- Abschlussbericht gemäß 002; Datei nach `prompts/done/`. Nächster Prompt: `011-retrieval-playground.md`.
