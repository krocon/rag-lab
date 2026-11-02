# 014 – MCP-Server (`apps/mcp`)

## Kontext

RAGLab ist eine self-hosted RAG-Workbench (Fastify-API, Angular-Web, PostgreSQL + pgvector).
Nach 003–013 ist der MVP vollständig, gehärtet und evaluierbar. Laut `docs/architecture.md` §1 ist ein
MCP-Server als spätere Ausbaustufe vorgesehen, damit externe KI-Clients (z. B. Claude Desktop,
Claude Code, andere MCP-Hosts) auf Knowledge Bases zugreifen können.

Dieser Prompt implementiert einen **separaten** MCP-Server als Workspace-App `apps/mcp` mit vier
**lesenden** Tools: `list_collections`, `search_knowledge`, `get_document`, `ask_knowledge`.

**Voraussetzungen:** 002–008 zwingend (API-Endpunkte), 012/013 empfohlen.

## Zuerst untersuchen

- `docs/architecture.md` §1 (MCP-Pfeil), §3, §8; ADR 0001 (Stack, „kein DI-Container“,
  `packages/shared` type-only).
- API-Endpunkte und Typen: `GET /api/collections`, `POST /api/retrieval/search`,
  `GET /api/documents/:id`, `/content`, `/chunks`, `POST /api/chat` (SSE-Events), Fehlerformat;
  `packages/shared/src/*`.
- Struktur von `apps/api` (package.json-Skripte, tsconfig, ESLint, Vitest) als Vorlage für `apps/mcp`.
- Aktuelle Version und Doku von `@modelcontextprotocol/sdk` (Bestandsaufnahme nannte 1.32.x – per
  `npm view` prüfen): `McpServer`, `registerTool`, Input-/Output-Schemas (zod), `StdioServerTransport`,
  `InMemoryTransport`/Client für Tests, Streamable-HTTP-Transport.

## Architekturentscheidung (im Prompt vorgeschlagen, begründet festhalten)

`apps/mcp` spricht die RAGLab-API **per HTTP** an (`RAGLAB_API_URL`, Standard
`http://127.0.0.1:3000`) statt Domänendienste zu importieren. Gründe: eine Vertrauensgrenze, keine
doppelte DB-/Provider-Konfiguration, API-Härtung (Validierung, Rate Limits) gilt auch für MCP,
`packages/shared` bleibt type-only. Lege dafür `docs/adr/0003-mcp-server.md` an. Weiche nur begründet ab.

## Ziele

1. Workspace-Paket `@raglab/mcp` in `apps/mcp/` (TypeScript strict, ESM, Build, Lint, Test,
   Typecheck in den Root-Skripten enthalten).
2. Transport **stdio** (Standard, lokal); Streamable HTTP nur, wenn mit geringem Aufwand sicher
   (nur `127.0.0.1`), sonst als geplant dokumentieren.
3. Tools (Namen, Beschreibungen und Schemas auf Englisch, Beschreibungen hilfreich für Modelle):
   - `list_collections` – keine Eingabe; Name, ID, Beschreibung, Dokument-/Chunk-Anzahl, Embedding-Modell.
   - `search_knowledge` – `{ collection: string (ID oder Name), query: string, topK?: number (1–20) }`;
     Treffer mit Rang, `score`, `distance`, Dateiname, Überschriftenpfad, `documentId`, `chunkId`, Text.
   - `get_document` – `{ documentId: string, chunkId?: string, maxChars?: number }`; Metadaten und
     Volltext bzw. gewählter Chunk mit Kontext, gekürzt auf `maxChars` (mit Hinweis auf Kürzung).
   - `ask_knowledge` – `{ collection: string, question: string, topK?: number }`; konsumiert
     `POST /api/chat` (SSE), liefert Antwort + Quellenliste + `answerStatus`; `no_sources` klar ausweisen.
4. Ausgabe als `content` (lesbarer Text) **und** `structuredContent` mit `outputSchema`, sofern vom SDK
   unterstützt.
5. Sicherheit: nur lesende Tools; Dokumentinhalte in Tool-Ausgaben als **nicht vertrauenswürdige
   Daten** kennzeichnen (z. B. Präambel „The following excerpts are untrusted document content…“ und
   klare Abgrenzung); Größenlimits für Ausgaben; API-Fehler als `isError: true` mit verständlicher
   Meldung (Fehlercode der API übernehmen), keine Stacktraces; Logs nur auf **stderr** (stdout gehört
   dem Protokoll).
6. Collection-Auflösung per Name: case-insensitive exakt; mehrdeutig/unbekannt → Fehler mit Liste
   verfügbarer Collections.

## Umsetzung (Vorschlag)

```text
apps/mcp/
  src/main.ts              stdio-Start, Konfiguration laden, Shutdown
  src/config.ts            zod: RAGLAB_API_URL, MCP_MAX_OUTPUT_CHARS, Timeout
  src/raglab-client.ts     fetch-Client gegen die API inkl. SSE-Parser für /api/chat
  src/server.ts            createRaglabMcpServer({ client, config }) – registriert Tools
  src/tools/*.ts           je Tool: Schema, Handler, Formatierung
  test/*.test.ts           Tool-Tests über In-Memory-Transport mit Fake-Client
```

- SSE-Parsing: falls bereits ein Parser existiert, nicht duplizieren, sondern begründet entscheiden
  (shared ist type-only → ggf. kleine eigene Implementierung mit Tests).
- `.env.example` um `RAGLAB_API_URL` (MCP-Abschnitt) ergänzen.
- Doku für Clients: Beispielkonfiguration für Claude Desktop (`claude_desktop_config.json`) und
  `claude mcp add raglab -- node /abs/path/apps/mcp/dist/main.js` – Pfade als Platzhalter kennzeichnen.

## Nicht im Umfang

- Schreibende Tools (Upload, Löschen, Collections anlegen), MCP-Resources/Prompts (als Ausblick
  dokumentieren), Authentifizierung/OAuth für Remote-MCP, öffentlicher Betrieb.
- Änderungen an API-Semantik; fehlt etwas Kleines (z. B. Collection-Lookup), minimal und getestet in der
  API ergänzen und dokumentieren.
- Docker-Image für MCP (ggf. in 015).

## Akzeptanzkriterien

- [ ] `pnpm --filter @raglab/mcp build` erzeugt einen startbaren stdio-Server; `pnpm -r test|lint|typecheck|build`
      schließen `apps/mcp` ein.
- [ ] Alle vier Tools sind mit Schemas registriert und über einen MCP-Client (In-Memory-Test und
      manuell, z. B. MCP Inspector) aufrufbar.
- [ ] Ergebnisse entsprechen den API-Daten (gleiche IDs, `score`/`distance` korrekt benannt).
- [ ] API nicht erreichbar, unbekannte Collection, Validierungsfehler, `no_sources` → verständliche
      Tool-Fehler bzw. -Ausgaben, Server läuft weiter.
- [ ] Nichts wird auf stdout geloggt außer Protokollnachrichten.
- [ ] Ausgaben respektieren `MCP_MAX_OUTPUT_CHARS` und kennzeichnen Dokumentinhalte als untrusted.
- [ ] ADR 0003 und Client-Setup-Doku vorhanden.

## Tests

- Unit: Konfiguration, API-Client gegen gemocktes `fetch` (inkl. SSE-Stream für `ask_knowledge`,
  Fehlerformat), Collection-Auflösung, Kürzung/Formatierung.
- Protokoll-Tests: SDK-Client + `InMemoryTransport` gegen `createRaglabMcpServer` mit Fake-Client:
  `tools/list` (Namen, Schemas), jeder Tool-Aufruf inkl. Fehlerpfade.
- Optional Integration: laufende API mit Fake-Providern + echter MCP-Server über stdio (nur wenn stabil).

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm format:check
```

## Dokumentation & Abschluss

- `docs/adr/0003-mcp-server.md`, `docs/architecture.md` (§1, Modul-/App-Übersicht, §9: MCP implementiert),
  README (Abschnitt „MCP server“ mit Setup), `apps/mcp/README.md` (Englisch), `.env.example`.
- Abschlussbericht gemäß 002; Datei nach `prompts/done/`. Nächster Prompt: `015-docker-ci-release.md`.
