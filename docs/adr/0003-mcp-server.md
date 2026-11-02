# ADR 0003 – MCP-Server (`apps/mcp`)

- Status: akzeptiert (umgesetzt mit Prompt 014)
- Datum: 2026-11-02

## Kontext

Externe KI-Clients (Claude Desktop, Claude Code, andere MCP-Hosts) sollen RAGLab-Knowledge-Bases
nutzen können: Collections auflisten, semantisch suchen, Dokumente/Chunks lesen und Fragen mit
Quellen beantworten lassen. `docs/architecture.md` §1 sah dafür einen MCP-Server als Ausbaustufe
vor („apps/mcp ──▶ apps/api bzw. Domänendienste“) – offen war, ob er die API per HTTP anspricht oder
die Domänendienste direkt importiert.

Randbedingungen: `packages/shared` ist type-only (ADR 0001), kein DI-Container, die API ist
gehärtet (Validierung, Rate Limits, `MAX_CONCURRENT_CHATS`, Fehlerformat; Prompt 012), und
Tool-Ergebnisse landen bei einem Modell, das meist weitere Tools besitzt.

## Entscheidungen

1. **Eigene Workspace-App `@raglab/mcp` (`apps/mcp/`)**, TypeScript strict, ESM, gleiche Werkzeuge
   wie `apps/api` (tsc-Build, Vitest, ESLint, Prettier); über `pnpm -r` in Lint, Typecheck, Test und
   Build und damit in CI enthalten.
2. **Zugriff ausschließlich über die HTTP-API** (`RAGLAB_API_URL`, Standard
   `http://127.0.0.1:3000`) mit `fetch`; keine Imports aus `apps/api`, keine DB- oder
   Provider-Konfiguration im MCP-Server.
3. **Transport stdio** (lokal, vom MCP-Client gestartet). Streamable HTTP wird **nicht** umgesetzt,
   sondern als geplant dokumentiert (Begründung unten).
4. **Vier lesende Tools:** `list_collections`, `search_knowledge` (→ `POST /api/retrieval/search`),
   `get_document` (→ `GET /api/documents/:id`, `/content`, `/chunks`), `ask_knowledge`
   (→ `POST /api/chat`, SSE vollständig konsumiert). Jedes Tool liefert lesbaren Text (`content`)
   und `structuredContent` mit `outputSchema` (zod, vom SDK als JSON-Schema veröffentlicht und
   validiert). Collection-Auflösung: exakte ID, sonst Name case-insensitiv exakt (getrimmt);
   unbekannt/mehrdeutig → Tool-Fehler mit Liste der Collections. Die Auflösung passiert im
   MCP-Server über `GET /api/collections` – die API braucht dafür keinen neuen Endpunkt.
5. **Fehler als Tool-Ergebnis** (`isError: true`) mit API-Fehlercode und Meldung, nie als
   Protokollfehler und nie mit Stacktrace; Abbruch durch den Client wird durchgereicht
   (`AbortSignal` → `fetch` → API bricht die Modellanfrage ab).
6. **Ausgaben sind begrenzt und gekennzeichnet:** `MCP_MAX_OUTPUT_CHARS` (Standard 20 000)
   begrenzt jedes Ergebnis (Auszüge werden gleichmäßig gekürzt, Kürzung wird angezeigt);
   Dokumentinhalte stehen hinter einer Präambel in Markern mit zufälliger ID pro Tool-Aufruf
   (`<<<BEGIN UNTRUSTED CONTENT id>>>` … `<<<END UNTRUSTED CONTENT id>>>`).
7. **Logs nur auf stderr** (stdout gehört JSON-RPC), per ESLint erzwungen (`no-console`,
   `process.stdout` verboten in `apps/mcp/src`).
8. **Eigener kleiner SSE-Parser** (`apps/mcp/src/sse.ts`, getestet) statt Wiederverwendung des
   Parsers aus `apps/web` (`core/api/sse-client.ts`).
9. **Abhängigkeiten:** `@modelcontextprotocol/sdk` `^1.32.2` (offizielles SDK; `npm view`: aktuelle
   Version, Peer `zod ^3.25 || ^4.0`) und `zod` `^4.6.7` (wie in der API). Das SDK bringt u. a.
   `express`, `hono`, `ajv` als transitive Abhängigkeiten mit; genutzt werden nur `McpServer`,
   `StdioServerTransport` und in Tests `Client`, `InMemoryTransport`, `StdioClientTransport`.

## Begründungen

- **HTTP statt Domänendienste:** eine Vertrauensgrenze statt zwei – Validierung, Rate Limits,
  `MAX_CONCURRENT_CHATS`, Host-Allowlist und Fehlerformat der API gelten automatisch auch für
  MCP-Clients. Keine doppelte DB-/Provider-Konfiguration, keine zweite Instanz des Indexers, keine
  konkurrierenden Pools; `packages/shared` bleibt type-only (Typen der Antworten kommen von dort).
  Preis: ein zusätzlicher HTTP-Hop (lokal vernachlässigbar) und die API muss laufen – ein klarer
  Fehler `API_UNREACHABLE` mit Hinweis auf `pnpm dev:api` macht das sichtbar.
- **Sicherheitsprüfungen der API werden nicht aufgeweicht:** Die Anfragen sind Server-zu-Server
  ohne `Origin`-Header (die CSRF-Prüfung betrifft nur Browser-Anfragen mit `Origin`); der
  `Host`-Header folgt aus `RAGLAB_API_URL` und muss in `ALLOWED_HOSTS` stehen; Rate Limits zählen
  MCP-Anfragen wie jede andere Anfrage (gemeinsamer Zähler pro IP mit dem Browser). Es gibt keine
  Ausnahme, keinen Bypass-Header und keine Konfigurationsänderung an der API.
- **stdio statt Streamable HTTP:** stdio ist der Standardweg lokaler MCP-Clients, hat keinen
  offenen Port und erbt die Rechte des startenden Benutzers – der ohnehin direkten Zugriff auf die
  lokale API hat. Ein HTTP-Transport bräuchte Host-/Origin-Prüfung gegen DNS-Rebinding,
  Session-Verwaltung und – sobald er nicht nur lokal lauscht – Authentifizierung (OAuth), die
  RAGLab nicht hat. Das ist nicht „mit geringem Aufwand sicher“ (Prompt 014) und folgt bei Bedarf.
- **Collection per Name:** Modelle kennen eher Namen als UUIDs; Namen sind in RAGLab
  case-insensitiv eindeutig. Exakter Vergleich (kein Präfix/Fuzzy), damit nie unbemerkt die falsche
  Collection durchsucht wird. Die zusätzliche Anfrage pro Tool-Aufruf ist lokal billig.
- **`topK` 1–20 statt 1–100:** Agenten brauchen selten mehr Treffer; mehr Treffer würden durch
  `MCP_MAX_OUTPUT_CHARS` ohnehin stark gekürzt.
- **Eigener SSE-Parser:** `packages/shared` darf keinen Laufzeitcode enthalten, und der Parser des
  Web-Clients gehört zur Angular-App. Die Logik ist klein (≈ 60 Zeilen), folgt denselben Regeln wie
  der Web-Parser und ist separat getestet. Ein gemeinsames Laufzeitpaket lohnt sich erst bei einem
  dritten Nutzer.
- **Marker mit Zufalls-ID:** Ein Dokument kann eine feste Endmarke imitieren; eine pro Aufruf
  zufällige ID kennt es nicht. Enthält ein Text die ID trotzdem, wird sie verändert. Das ist –
  wie bei der Begrenzer-Neutralisierung im Chat-Prompt – nur Strukturschutz, kein Schutz vor
  Prompt-Injection (security.md §11).

## Konsequenzen

- Die API muss laufen, bevor ein MCP-Client die Tools nutzt; Konfiguration des Clients mit
  `node /abs/path/apps/mcp/dist/main.js` (nicht `pnpm start`, pnpm schreibt auf stdout).
- Neue API-Endpunkte oder -Felder erreichen MCP-Clients erst, wenn ein Tool sie nutzt; die Typen
  kommen aus `packages/shared`, Abweichungen fallen im Typecheck auf.
- MCP-Anfragen teilen sich die Rate-Limit-Zähler mit dem Web-UI (gleiche IP `127.0.0.1`).
- Kein Docker-Image für `apps/mcp` (stdio-Server werden vom Client lokal gestartet; ggf. Prompt 015).
  _Nachtrag 015:_ optionales Image `raglab-mcp` (`infra/docker/mcp.Dockerfile`, Compose-Profil
  `mcp`, [release.md](../release.md) §3); der lokale Start mit `node` bleibt der Standardweg.
- **Ausblick:** MCP-Resources (z. B. `raglab://collections/{id}/documents/{id}`), MCP-Prompts,
  schreibende Tools (Upload, Reindex) nur mit Bestätigungsmodell, Streamable HTTP mit
  Authentifizierung für Remote-Betrieb.
