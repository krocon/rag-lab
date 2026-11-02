# 012 – Security & Hardening

## Kontext

RAGLab ist eine self-hosted RAG-Workbench (Fastify-API, Angular-Web, PostgreSQL + pgvector, Ollama).
Nach 003–011 ist der MVP-Funktionspfad vorhanden: Collections, Upload (MD/TXT), Chunking, Embeddings,
Retrieval, Chat per SSE, Knowledge-UI, Chat-UI, Playground. Grundlegende Schutzmaßnahmen sind verteilt
umgesetzt (Validierung, Upload-Allowlist, abgegrenzte Quellen im Prompt, CORS-Allowlist, lokales Binding).

Dieser Prompt prüft und härtet das System systematisch und dokumentiert das Bedrohungsmodell mit
Restrisiken. Es gibt bewusst **keine Benutzerverwaltung** im MVP – die Härtung muss dazu passen.

**Voraussetzungen:** 002–011 erledigt (mindestens 003–008).

## Zuerst untersuchen

- `docs/architecture.md` §1 (Vertrauensgrenzen), §6, §7, §8; ADR 0002 „Sicherheit: Prompt-Injection“;
  `SECURITY.md`.
- `apps/api/src/app.ts` (Plugins, CORS, `bodyLimit`, Error-Handler), alle `*.routes.ts` (Schemas,
  `additionalProperties`), Upload-Route und `ingestion/*`, `chat/prompt-builder.ts`, Logging-Konfiguration.
- `apps/web`: Stellen mit `innerHTML`, `bypassSecurityTrust*`, Markdown-Rendering, externe Ressourcen.
- `.env.example`, `docker-compose.yml`, `infra/docker/*`, `.github/workflows/ci.yml`.
- Aktuelle Versionen von `@fastify/helmet` und `@fastify/rate-limit` per `npm view` prüfen.
Erstelle zuerst eine kurze Befundliste (was ist schon gut, was fehlt), dann ändere gezielt.

## Ziele

1. **Eingabevalidierung:** Jede Route hat vollständige Schemas (Params, Query, Body, Response),
   `additionalProperties: false`, Längen-/Bereichsgrenzen (`query`, `question`, `name`, `topK`, …).
   Response-Schemas verhindern das versehentliche Ausliefern interner Felder.
2. **Upload-Sicherheit:** Allowlist nach Endung, Binärerkennung (NUL-Bytes/Anteil nicht druckbarer
   Zeichen), striktes UTF-8, Größen- und Anzahl-Limits, Dateinamen-Bereinigung (Pfade, Steuerzeichen,
   Bidi-Overrides, Länge), keine Speicherung im Dateisystem, Anzahl Dokumente pro Collection begrenzbar
   (`MAX_DOCUMENTS_PER_COLLECTION`, optional), Gesamt-Request-Timeout.
3. **Prompt-Injection:** Neutralisierung der Begrenzer überprüfen und erweitern (Varianten mit
   Whitespace, Groß-/Kleinschreibung, Unicode-Lookalikes soweit sinnvoll), Systemprompt reviewen,
   Modell erhält keine Tools; Testdokument `apps/api/test/fixtures/security/prompt-injection.md`.
   Restrisiko ehrlich dokumentieren.
4. **Secrets:** pino-`redact` für Header (`authorization`, `cookie`) und Konfigurationsfelder mit
   Keys; keine Dokumentinhalte, Queries oder Antworten im Info-Log; `/api/system/*` gibt keine URLs
   mit Credentials oder API-Keys aus (Test); `DATABASE_URL` nie loggen.
5. **CORS:** Allowlist aus `CORS_ORIGINS`, kein `*`, Methoden/Header einschränken; Verhalten bei
   fehlendem `Origin` dokumentieren.
6. **Rate Limits:** `@fastify/rate-limit` global (z. B. 300/min) und strenger für Upload, Chat,
   Retrieval/Playground (Werte konfigurierbar: `RATE_LIMIT_*`), Antwort `429 RATE_LIMITED` im
   Fehlerformat mit `Retry-After`. Begrenzung gleichzeitiger SSE-Streams (`MAX_CONCURRENT_CHATS`).
7. **Security-Header:** `@fastify/helmet` mit CSP passend für API und Swagger-UI (ggf. Swagger-UI in
   Produktion abschaltbar: `API_DOCS_ENABLED`); für die Web-App CSP/Header im Web-Container
   (nginx-Konfiguration aus 015 oder vorhandene Datei) bzw. dokumentierter Plan.
8. **Fehler & Betrieb:** Keine Stacktraces in Antworten (auch `NODE_ENV=production`), Warnung beim Start,
   wenn `API_HOST` nicht lokal ist und keine schützende Schicht konfiguriert ist; Hinweis in README,
   dass RAGLab ohne Reverse-Proxy mit Authentifizierung nicht öffentlich betrieben werden darf.
9. **Frontend:** kein `innerHTML` mit untrusted Daten, kein `bypassSecurityTrust*`, externe Links mit
   `rel="noopener noreferrer"`.
10. **Supply Chain:** `pnpm audit --prod` in CI (Fehlerschwelle begründen), Dependabot/Renovate-Konfig
    vorschlagen (Datei anlegen, Aktivierung beim Maintainer).

## Umsetzung (Vorschlag)

- `apps/api/src/http/security.ts`: Registrierung von helmet und rate-limit, aus `buildApp` aufgerufen,
  per Konfiguration steuerbar (Tests können Limits setzen).
- `apps/api/src/modules/chat/sanitize-source.ts` (oder bestehende Stelle): Neutralisierung zentral.
- `docs/security.md` (Deutsch): Bedrohungsmodell (Assets, Vertrauensgrenzen, Angreifer: bösartiges
  Dokument, bösartige Website im Browser des Nutzers via CSRF/CORS, lokaler Angreifer), Maßnahmen,
  Restrisiken, Betriebsempfehlungen. `SECURITY.md` (Englisch) verlinkt darauf, ohne Interna zu duplizieren.

## Nicht im Umfang

- Authentifizierung, Benutzer, Rollen, Multi-Tenancy (nur dokumentieren, wie man einen Reverse-Proxy
  mit Auth davorsetzt).
- Verschlüsselung at rest, WAF, Virenscanner, externe Pentests.
- Neue Dateiformate.

## Akzeptanzkriterien

- [ ] Befundliste im Abschlussbericht (vorher/nachher).
- [ ] Jede Route hat Request- **und** Response-Schemas; zusätzliche Felder → `400`.
- [ ] Rate Limits greifen und liefern `429` im Fehlerformat; Limits konfigurierbar und in `.env.example`.
- [ ] Security-Header (u. a. `x-content-type-options`, CSP, `referrer-policy`) auf API-Antworten;
      Swagger-UI funktioniert weiterhin (bzw. ist dokumentiert abschaltbar).
- [ ] CORS: fremde Origin erhält keine CORS-Freigabe (Test).
- [ ] Präpariertes Injection-Dokument erscheint im Prompt nur innerhalb eines Quellblocks, Begrenzer
      neutralisiert (Test); Restrisiko dokumentiert.
- [ ] Log-Tests: Dokumentinhalte und Secrets erscheinen nicht in Logs.
- [ ] Upload-Härtung: Bidi-/Pfad-Dateinamen, Binärdaten, zu viele Dateien sind abgedeckt.
- [ ] `docs/security.md` existiert, `SECURITY.md` verweist darauf.

## Tests

- Unit/Route (`app.inject()`): Schema-Strenge pro Route (Tabellen-Test), `429` mit niedrigen Test-Limits,
  Header-Präsenz, CORS mit erlaubter/fremder Origin, Fehler ohne Stacktrace in `production`,
  Dateinamen-Bereinigung, Binärerkennung, Neutralisierung (Varianten), Log-Redaction (Logger mit
  Test-Stream, Ausgabe durchsuchen).
- Integration: Upload des Injection-Dokuments → Chat mit Fake-Provider → aufgezeichneter Prompt prüft
  Abgrenzung.
- Web: Test, dass Quelleninhalt mit HTML/Script als Text erscheint.

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build && pnpm format:check
pnpm audit --prod
```

## Dokumentation & Abschluss

- `docs/security.md` (neu), `docs/architecture.md` §8 + §9, `SECURITY.md`, README (Betriebshinweis),
  `.env.example` (alle neuen Variablen mit sicheren Defaults).
- Abschlussbericht gemäß 002; Datei nach `prompts/done/`. Nächster Prompt: `013-test-and-evaluation.md`.
