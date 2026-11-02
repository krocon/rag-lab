# 009 – Angular Knowledge UI (Übersicht, Collection-Detail, Upload, Status)

## Kontext

RAGLab ist eine self-hosted RAG-Workbench. Das Backend (Fastify) bietet nach 003–006:
Collections-CRUD, Upload von Markdown/TXT (`202`, asynchrone Indexierung), Dokumentstatus
(`pending` → `processing` → `ready` | `failed`), Chunks und Reindex. Die Angular-22-App (`apps/web`,
standalone, Signals, zoneless, Vitest) hat bisher nur Shell, Navigation, Welcome-Seite mit Live-Status
und eine read-only Settings-Seite.

Dieser Prompt baut die Knowledge-Base-Oberfläche: Übersicht, Anlegen/Bearbeiten/Löschen,
Collection-Detail mit Dokumentliste, Upload mit Fortschritt, Statusanzeige mit Polling und eine
Dokumentansicht mit Volltext und Chunks.

**Voraussetzungen:** 002–006 erledigt (008 empfohlen, aber nicht nötig).

## Zuerst untersuchen

- `apps/web/`: `app.config.ts`, `app.routes.ts`, Shell/Navigation, vorhandener API-Service unter
  `src/app/core/`, Welcome- und Settings-Feature (Stil, Komponentenmuster, Theme-Tokens, Tests),
  `proxy.conf.json` (`/api` → `http://localhost:3000`), `angular.json`, Vitest-Setup.
- `packages/shared/src/` (Collections-, Document-, Chunk-, Error-Typen) – das UI nutzt **diese**
  Typen per `import type`, keine Duplikate.
- OpenAPI unter `/api/docs` für die tatsächlichen Endpunkte und Fehlercodes.
- `docs/architecture.md` §8 (Rendering-Regeln), UX-Abschnitt in 001 (Barrierefreiheit).
Bestehende Konventionen (Dateinamen, Selector-Präfix, Styling-Ansatz) übernehmen; keine UI-Bibliothek
ohne Begründung und Rücksprache, wenn bisher keine verwendet wird.

## Ziele

1. Route `/knowledge-bases`: Liste der Collections mit Dokument-/Chunk-Zahlen, Empty State mit
   Call-to-Action, Anlegen (Name, Beschreibung) mit Validierung und Server-Fehlern (`409`).
2. Route `/knowledge-bases/:collectionId`: Kopf mit Name, Beschreibung, Embedding-Modell und
   -Dimension; Bearbeiten; Löschen mit Bestätigungsdialog (nennt Anzahl betroffener Dokumente).
3. Dokumenttabelle: Dateiname, Größe, Status, Chunk-Anzahl, Zeitpunkt, Aktionen (Reindex bei
   `failed`, Löschen). Status als Text + Icon, **nicht nur Farbe**; `failed` zeigt `errorMessage`.
4. Upload: Dateiauswahl und Drag & Drop, mehrere Dateien, clientseitige Vorprüfung (Endung, Größe aus
   `/api/system/info` falls verfügbar), Upload-Fortschritt, serverseitige Fehler pro Datei
   (`415`, `413`, `409` mit Link auf das vorhandene Dokument).
5. Polling: Solange Dokumente `pending`/`processing` sind, Status periodisch aktualisieren; Polling
   stoppt bei Verlassen der Seite bzw. wenn alles abgeschlossen ist.
6. Route `/knowledge-bases/:collectionId/documents/:documentId`: Metadaten, normalisierter Volltext
   (als Text gerendert) und Chunk-Liste mit Index, Offsets, Überschriftenpfad, Zeichenanzahl,
   Embedding vorhanden ja/nein. Deep-Link auf einen Chunk (`?chunk=<chunkId>`) scrollt und hebt hervor –
   wird von Chat (010) und Playground (011) genutzt.

## Umsetzung (Vorschlag)

- `src/app/core/api/`: typisierter API-Client (HttpClient, `firstValueFrom` oder `httpResource`/
  `resource` – vorhandenes Muster übernehmen) mit Methoden für Collections, Documents, Chunks, Upload
  (`reportProgress: true`), Reindex. Fehler werden auf `ApiErrorResponse` gemappt
  (`src/app/core/api/api-error.ts`), unbekannte Fehler bekommen eine generische Meldung.
- `src/app/features/knowledge-bases/`:
  `knowledge-base-list.page.ts`, `collection-form.component.ts`, `collection-detail.page.ts`,
  `document-table.component.ts`, `document-upload.component.ts`, `document-status.component.ts`,
  `document-detail.page.ts`, `confirm-dialog` (in `src/app/shared/ui/`, falls wiederverwendbar).
- State lokal mit Signals (`signal`, `computed`, ggf. `linkedSignal`); keine globale Store-Bibliothek.
- Routen lazy (`loadComponent`); Titel pro Route (`title`); Breadcrumb oder Zurück-Link.
- Barrierefreiheit: semantische Tabelle mit `<caption>`/`scope`, Labels an allen Feldern,
  Fehlermeldungen per `aria-describedby`, Statusänderungen über eine höfliche Live-Region,
  Dialog mit Fokusfalle und Rückgabe des Fokus, Drag & Drop hat Tastatur-Alternative (Dateiauswahl).
- Lade-, Fehler- und Empty-States für jede Ansicht; Retry bei Ladefehlern.
- Dokumentinhalte nur als Text interpolieren (kein `innerHTML`, kein `bypassSecurityTrust*`).

## Nicht im Umfang

- Chat-UI (010), Retrieval Playground (011), Settings-Bearbeitung.
- Markdown-Rendering des Dokuments (Volltext wird als vorformatierter Text gezeigt).
- Neue Backend-Features; fehlt ein Endpunkt, minimal und getestet ergänzen und dokumentieren – oder
  im Bericht als offen markieren.
- Pagination, Suche/Filter in Listen, Bulk-Aktionen, URL-Import.

## Akzeptanzkriterien

- [ ] Gesamter Ablauf im Browser: Collection anlegen → Dateien hochladen → Status wechselt sichtbar
      bis `ready` (oder `failed` mit Meldung) → Dokument öffnen → Chunks sehen → löschen.
- [ ] Server-Validierungsfehler erscheinen am richtigen Feld bzw. pro Datei, verständlich formuliert.
- [ ] Polling startet/stoppt korrekt und läuft nach Verlassen der Seite nicht weiter.
- [ ] Alle Aktionen per Tastatur bedienbar, sichtbarer Fokus, Status nicht nur farbcodiert,
      Kontraste in Light/Dark-Theme ausreichend (Ziel WCAG 2.2 AA).
- [ ] Deep-Link auf einen Chunk funktioniert.
- [ ] Keine erfundenen Daten: Was die API nicht liefert, wird nicht angezeigt.
- [ ] Navigation und Welcome-Seite verlinken die neue Ansicht.

## Tests

- Vitest-Komponententests mit `HttpTestingController` bzw. Fake-API-Service: Liste/Empty State,
  Formularvalidierung + `409`, Upload (Fortschritt, Fehler pro Datei, clientseitige Vorprüfung),
  Statusdarstellung aller vier Zustände, Polling-Start/-Stopp (Fake-Timer), Löschdialog, Deep-Link.
- Unit-Tests für API-Client und Fehler-Mapping.
- Barrierefreiheit: Tests auf Rollen/Labels (z. B. Abfragen über Rolle und zugänglichen Namen).

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm format:check
pnpm db:up && pnpm db:migrate && pnpm dev   # manuelle Prüfung des Ablaufs
```

## Dokumentation & Abschluss

- `docs/architecture.md` §9 (Web: Knowledge Bases), README (Screens/Ablauf kurz beschreiben).
- Abweichungen (z. B. neue Endpunkte) in `docs/architecture.md` und OpenAPI.
- Abschlussbericht gemäß 002; Datei nach `prompts/done/`. Nächster Prompt: `010-angular-chat-ui.md`.
