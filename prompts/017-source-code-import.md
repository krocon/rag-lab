# 017 – Quellcode-Import: lokales Verzeichnis oder Git-URL als Knowledge Base

## Kontext

RAGLab (Version 0.1.0, Prompts 001–016 erledigt) indexiert heute nur einzeln hochgeladene Markdown-
und Textdateien (`.md`, `.markdown`, `.txt`). Gespeichert wird nur der letzte Pfadteil des
Dateinamens; das Chunking kennt die Formate `markdown` und `text`.

Ziel dieses Prompts: Ein Nutzer gibt **ein lokales Verzeichnis oder eine Git-URL** an, z. B.

```bash
pnpm kb:import --source /Users/marckronberg/WebstormProjects/video/2026/guiexpert-table/mono --name guiexpert
pnpm kb:import --source https://github.com/guiexperttable/mono --name guiexpert
```

RAGLab durchsucht das Verzeichnis rekursiv und liest **alle Quellcode-, Markdown- und Textdateien**
ein – ohne `node_modules`, `dist` und andere Build-, Cache- oder generierte Verzeichnisse (vollständige
Regeln in Ziel 3). Danach beantwortet es Fragen wie:

> How do I have to structure my data so that I can use it as a tree table, and what does the code
> look like?

Die Antwort soll sich auf echte Quelltext- und Doku-Stellen stützen und sie mit **Pfad und
Zeilenbereich** zitieren.

Referenz-Repository für Entwicklung und Abnahme: `https://github.com/guiexperttable/mono`, lokal
ausgecheckt unter `/Users/marckronberg/WebstormProjects/video/2026/guiexpert-table/mono`
(TypeScript-Monorepo: Kernbibliothek, Wrapper für sieben Frameworks, Demo-Apps, Developer Guide
`instructions.md`, `llms.txt`). Laut `git ls-files` rund 930 `.ts`-, 785 `.md`-, 1.200 `.html`-,
230 `.astro`-, 190 `.json`-Dateien sowie Bilder/Fonts; viele davon generiert oder doppelt. Der
lokale Checkout ist ein Git-Arbeitsverzeichnis mit **mehreren `.gitignore`-Dateien** (Wurzel und
einzelne Apps) und einer Remote-URL mit eingebettetem Benutzernamen (`https://<user>@github.com/…`)
– beides sind echte Testfälle für Dateiauswahl und URL-Bereinigung. Beide Wege (lokales Verzeichnis
**und** Git-URL) werden gegen dieses Repository abgenommen. Fragen werden auf **Englisch** gestellt;
Mehrsprachigkeit ist nicht Teil dieses Prompts.

**Voraussetzungen:** 002 (Projektregeln, Definition of Done), 004–008, 011, 012, 014.

Bereits vorhanden und zu berücksichtigen: `scripts/kb-collect.mjs` + `scripts/kb/collect-lib.mjs`
(`pnpm kb:collect`) kopieren Markdown-/Textdateien in einen flachen Ordner und kodieren den Pfad im
Dateinamen. Das ist eine Übergangslösung. Entscheide begründet, ob die Bibliothek (Pfad-Filter,
Duplikat-Plan) wiederverwendet wird und ob `kb:collect` danach entfällt oder bleibt.

## Zuerst untersuchen

- `docs/architecture.md`, `docs/data-model.md`, ADR 0002 (RAG-Pipeline), ADR 0003 (MCP spricht die
  API per HTTP an), `docs/security.md` (Bedrohungsmodell, Upload-Härtung).
- Ingestion: `apps/api/src/modules/ingestion/*` (`file-type.ts`, `prepare-upload.ts`,
  `normalize.ts`, `metadata.ts`, `document-indexer.ts`), `documents.routes.ts`/`.service.ts`,
  Limits in `config/env.ts` (`MAX_UPLOAD_BYTES`, `MAX_UPLOAD_FILES`, `MAX_UPLOAD_REQUEST_BYTES`,
  `MAX_DOCUMENTS_PER_COLLECTION`, `RATE_LIMIT_UPLOAD_MAX`).
- Chunking: `apps/api/src/modules/chunking/*` und die Invarianten in `test/chunking/invariants.ts`
  (insbesondere `content === text.slice(startOffset, endOffset)`), Golden- und Property-Tests.
- Embedding-Schritt (`embedding.step`), Retrieval-Service, Prompt-Builder (`chat/prompt-builder.ts`
  mit Snapshot-Test), Zitatprüfung, Playground.
- Datenmodell `apps/api/src/db/schema.ts`: `documents.filename`, `documents.metadata`,
  `chunks.heading_path`, `chunks.metadata`.
- `scripts/demo-seed.mjs` + `scripts/demo/seed-lib.mjs` als Vorlage für einen Client, der nur die
  öffentliche REST-API nutzt (idempotent, wartet auf Indexierung).
- Web: Collection-Detail, Dokument-/Chunk-Ansicht, Quellenkarten im Chat, Playground-Tabelle.
- MCP: `apps/mcp/src/tools/*` (Ausgabeformat von `search_knowledge`, `get_document`).
- Das Referenz-Repository selbst: Welche Verzeichnisse enthalten Handgeschriebenes, welche
  Generiertes (TypeDoc-Ausgabe `docsmd`, `dist`, `angular-builds`, doppelte Website-Apps)?
- Embedding-Provider: Setzt RAGLab die von `nomic-embed-text` erwarteten Aufgaben-Präfixe
  (`search_query:` / `search_document:`)? Nur prüfen und mit Empfehlung im Abschlussbericht
  festhalten, nicht ändern (siehe „Nicht im Umfang“).

Halte das Ergebnis der Untersuchung kurz im Abschlussbericht fest, bevor du Entscheidungen triffst.

## Architekturentscheidung (Vorschlag – begründet bestätigen oder abweichen, als ADR 0004)

**Der Import läuft als Client auf dem Rechner des Nutzers, nicht im API-Server.**

Ein neues CLI-Kommando (`pnpm kb:import`, `scripts/kb-import.mjs` + Bibliothek mit Tests) liest das
Verzeichnis, filtert, und lädt die Dateien über die öffentliche REST-API hoch – wie `demo:seed`.
Für eine Git-URL klont **das CLI** mit dem lokal installierten `git` flach (`--depth 1`,
optional `--branch`/`--ref`) in ein temporäres Verzeichnis und räumt es danach auf.

Gründe: Der API-Server liest keine beliebigen Pfade seines Dateisystems und holt keine fremden
URLs (kein SSRF, kein Path Traversal, kein `git` im Container, non-root-/read-only-Images bleiben
unverändert); eine Vertrauensgrenze wie in ADR 0003; private Repositories funktionieren mit den
Git-Zugangsdaten des Nutzers, ohne dass RAGLab sie je sieht.

Die Web-App bekommt in diesem Prompt **keinen** Import-Dialog für Pfade oder URLs; sie zeigt die
importierten Quellen an (siehe Ziel 6). Ein serverseitiger Import ist ein möglicher späterer Prompt
und wird im ADR als verworfene Alternative mit Begründung genannt.

## Ziele

### 1. API: Quellcode-Dateien und Pfade annehmen

- Allowlist erweitern (Erweiterung → Typ, weiterhin nie vom Client übernommen). Mindestens:
  `.ts .tsx .js .jsx .mjs .cjs .vue .svelte .astro .html .css .scss .json .yaml .yml .toml .sh
  .py .java .kt .go .rs .cs .sql` sowie die bisherigen Textformate. Die Liste ist eine Konstante mit
  Sprachzuordnung (`language`: `typescript`, `html`, …) und in den Docs tabelliert.
- **Relativer Pfad** je Dokument: Der Client sendet ihn mit (z. B. `packages/table/src/x.ts`); der
  Server validiert streng (relativ, `/` als Trenner, keine `..`-, leeren oder absoluten Segmente,
  keine Steuer-/Bidi-Zeichen, Längenlimit) und speichert ihn. Der Pfad ist **eindeutig pro
  Collection** (Grundlage für Idempotenz und `--sync`); erzwinge das in der Datenbank. Entscheide
  zwischen neuer Spalte und `documents.metadata` (Migration, Index, Sortierung/Filter). Der Pfad ist
  reine Anzeige- und Metadaten-Information und wird nie als Dateisystempfad verwendet.
- **Import-Quelle** je Collection oder Dokument festhalten (Art `directory`/`git`, bei Git: URL ohne
  Zugangsdaten, Ref, Commit-SHA; Importzeitpunkt), damit die UI Links auf den Quelltext bauen kann.
  URLs mit eingebetteten Zugangsdaten (`https://user:token@…`) werden abgelehnt bzw. vor dem
  Speichern bereinigt und nie geloggt.
- Bestehende Uploads ohne Pfad funktionieren unverändert (Rückwärtskompatibilität, keine
  Verhaltensänderung für `demo:seed`).

### 2. Chunking für Quellcode

- Neues Format `code` im Chunker, **deterministisch und ohne schwere Parser-Abhängigkeit**
  (kein Tree-sitter in diesem Prompt; als Ausblick dokumentieren). Schnittstellen in dieser
  Reihenfolge bevorzugen: Grenzen von Top-Level-Deklarationen (heuristisch pro Sprachfamilie:
  `export`, `class`, `function`, `interface`, `type`, `const … =`, Dekoratoren und führende
  Doc-Kommentare bleiben bei ihrer Deklaration) → Leerzeilen → Zeilenenden. Nie mitten in einer
  Zeile schneiden; zu lange Einzelzeilen (minifizierter Code) sind ein Ausschlussgrund im Client
  und ein definierter Fallback im Server.
- Alle bestehenden Invarianten gelten weiter (Offsets, `content === text.slice(…)`, Überlappung).
- Je Chunk zusätzlich **`startLine`/`endLine`** (1-basiert) und, soweit erkennbar, der umgebende
  Symbolname (`class TreeFactory`, `function createTableModel`) in `chunks.metadata`;
  `headingPath` trägt Pfad und Symbol (z. B. `["packages/table/src/tree/x.ts", "class X"]`).
- **Kontext fürs Embedding:** Der eingebettete Text darf um einen kurzen Kopf ergänzt werden
  (`File: <path>` / `Symbol: <name>`), der gespeicherte `content` bleibt unverändert. Begründet
  entscheiden, testen und im Playground sichtbar machen, was tatsächlich eingebettet wurde.
- Markdown-Dateien behalten das Markdown-Chunking; Code-Blöcke darin werden nicht zerschnitten,
  wenn das ohne Bruch der Invarianten möglich ist (sonst als bekannte Grenze dokumentieren).

### 3. CLI `pnpm kb:import`

```text
pnpm kb:import --source <dir | git-url> --name <collection>
               [--ref <branch|tag|sha>] [--include <glob>]... [--exclude <glob>]...
               [--max-bytes <n>] [--api-url <url>] [--sync] [--dry-run] [--timeout <s>]
```

- **Dateiauswahl:** Eingelesen werden alle Dateien, deren Erweiterung in der Allowlist aus Ziel 1
  steht (Quellcode, Markdown, Text, Konfiguration), rekursiv unter `--source`. In einem
  Git-Arbeitsverzeichnis `git ls-files` verwenden (respektiert alle `.gitignore`-Dateien und
  `.git/info/exclude`); sonst rekursiv laufen und **alle** `.gitignore`-Dateien im Baum mit
  korrekter Verzeichnis-Relativität auswerten (nicht nur die im Wurzelverzeichnis).
  Immer ausgeschlossen, auch wenn sie versioniert sind: `node_modules`, `dist`, `build`, `out`, `coverage`, `.git`, `.angular`,
  `.nx`, Caches; Lockfiles; Binär- und Mediendateien (Erkennung über Erweiterung **und**
  NUL-Byte-Prüfung); `*.min.*`, Source Maps; Dateien über `--max-bytes`; Dateien mit überlangen
  Zeilen; Symlinks, die aus dem Quellverzeichnis hinausführen.
- **Geheimnisse:** `.env*`, Schlüssel-/Zertifikatsdateien (`*.pem`, `*.key`, `id_rsa*`, …) und
  ähnliche werden **nie** hochgeladen, auch nicht mit `--include`. Der Dry-Run nennt sie als
  übersprungen.
- **Generiertes und Doppeltes:** Inhaltsgleiche Dateien nur einmal (Hash). Sinnvolle
  Standard-Ausschlüsse für generierte Doku dokumentieren; projektspezifische Regeln über
  `--exclude` oder eine optionale Datei `.raglabignore` (gitignore-Syntax) im Quellverzeichnis.
- **`--dry-run`** (wichtig, zuerst implementieren): Liste und Zusammenfassung nach Erweiterung
  (Anzahl, Bytes), übersprungene Dateien mit Grund, grobe Schätzung der Chunk-Anzahl – ohne
  Netzwerkzugriff auf die API.
- **Hochladen:** nur über die REST-API, in Stapeln innerhalb der Server-Limits, mit Fortschritt,
  Wiederholung bei `429` (Retry-After beachten) und verständlichen Fehlern. Prüfe, ob die
  Standard-Limits (`RATE_LIMIT_UPLOAD_MAX=30`/min, `MAX_DOCUMENTS_PER_COLLECTION`) für einige
  tausend Dateien praktikabel sind; passe Standardwerte oder Stapelung begründet an, ohne die
  Härtung aus 012 aufzuweichen.
- **Idempotenz und `--sync`:** Ein zweiter Lauf lädt nur neue oder geänderte Dateien (Pfad + Hash).
  Mit `--sync` werden geänderte Dateien ersetzt und im Quellverzeichnis gelöschte Dateien aus der
  Collection entfernt – vorher Zusammenfassung ausgeben; ohne `--sync` wird nichts gelöscht.
- **Git-URL:** nur `https://` und `ssh`/`git@`; eingebettete Zugangsdaten (`user@` oder
  `user:token@`) werden vor dem Speichern und vor jeder Ausgabe entfernt. Ist `--source` ein lokales
  Git-Arbeitsverzeichnis, werden Remote-URL (bereinigt), Branch und Commit-SHA als Quelle
  übernommen, damit auch dort Links auf den Quelltext möglich sind. Flacher Klon in ein temporäres Verzeichnis, Commit-SHA
  ermitteln und als Quelle melden, Aufräumen auch im Fehlerfall. Kein Ausführen von Hooks oder
  Skripten aus dem Repository, keine Submodule ohne ausdrückliche Option.
- Benötigt nur Node.js (und `git` für URLs); Exit-Code 1 bei Fehlern wie in `demo:seed`.

### 4. Retrieval, Prompt und Zitate

- Quellenblöcke im Prompt tragen Pfad, Zeilenbereich und Sprache; Code steht in einem
  Code-Zaun mit Sprachkennung. Der Systemprompt verlangt bei Code-Fragen: Antwort aus den Quellen,
  Code-Beispiele nur aus oder eng an den Quellen, fehlende Teile benennen statt erfinden.
  Snapshot-Test aktualisieren; die Injection-Härtung aus 012 (Quellen sind Daten, keine
  Anweisungen) gilt unverändert – Kommentare im Code sind ein neuer Injection-Weg und bekommen
  einen eigenen Testfall.
- Kontext-Budget prüfen (`CHAT_CONTEXT_CHAR_BUDGET`, `RETRIEVAL_TOP_K`): Code-Chunks sind dichter.
  Standardwerte nur begründet ändern.
- Optional, wenn mit geringem Aufwand sauber: Filter im Retrieval nach Pfad-Präfix oder Sprache
  (`packages/table/`, `typescript`), im Playground bedienbar. Sonst als Ausblick dokumentieren.

### 5. Evaluation

- Kleiner, selbst geschriebener Code-Datensatz unter `eval/datasets/` (keine fremden Quelltexte
  mit unklarer Lizenz) mit Fragen und erwarteten Dateien; `pnpm eval` deckt ihn ab.
- Manuelle Abnahme gegen das Referenz-Repository mit echten Ollama-Modellen (siehe
  Akzeptanzkriterien). Ergebnisse (Fragen, Treffer, Bewertung) in `docs/evaluation.md`.

### 6. Web-App

- Collection-Detail: Import-Quelle (Verzeichnis oder Repository, Ref, Commit, Zeitpunkt);
  Dokumenttabelle mit Pfad, Sprache, Filter nach Pfad-Präfix; brauchbar bei einigen tausend
  Dokumenten (Paginierung oder virtuelles Scrollen, serverseitig gefiltert).
- Dokument-/Chunk-Ansicht: Code in Monospace mit Zeilennummern, Chunk-Grenzen sichtbar.
- Chat-Quellenkarten und Playground: `Pfad:Start–Ende`, Sprache; bei Git-Quellen ein Link auf die
  Datei im Repository am gespeicherten Commit (`…/blob/<sha>/<path>#L10-L42`), nur für bekannte
  Hosts mit sicher gebildeter URL.
- Weiterhin keine HTML-Interpretation von Dokumentinhalten (reiner Text, kein `innerHTML`).

### 7. MCP

- `search_knowledge` und `get_document` geben Pfad, Zeilenbereich und Sprache mit aus
  (`content` und `structuredContent`); Schemas und Tests anpassen. Keine neuen schreibenden Tools.

## Nicht im Umfang

- Serverseitiger Import (Pfad/URL in der Web-App), Hintergrund-Synchronisation, Webhooks.
- Tree-sitter oder andere AST-Parser; Symbolgraph, „Go to definition“, Abhängigkeitsanalyse.
- Hybrid-Suche (Stichwort + Vektor) und Reranking – für Code voraussichtlich der größte nächste
  Qualitätshebel; als eigener Prompt vorschlagen, wenn die Abnahme das bestätigt.
- Wechsel oder Vergleich von Embedding-Modellen, Aufgaben-Präfixe (`search_query:` /
  `search_document:` bei `nomic-embed-text`; nur prüfen, siehe „Zuerst untersuchen“), mehrsprachige
  Suche.
- PDF, DOCX, Notebooks, Bilder.
- Authentifizierung, mehrere Nutzer.

## Akzeptanzkriterien

- [ ] `pnpm kb:import --source <dir> --name X --dry-run` listet Dateien, Zusammenfassung nach
      Erweiterung und übersprungene Dateien mit Grund – ohne API-Zugriff.
- [ ] `pnpm kb:import --source <dir> --name X` und `--source <git-url>` legen die Collection an,
      laden alles hoch und warten, bis alle Dokumente `ready` oder `failed` sind; ein zweiter Lauf
      lädt nichts erneut; `--sync` ersetzt geänderte und entfernt gelöschte Dateien.
- [ ] `pnpm kb:import --source /Users/marckronberg/WebstormProjects/video/2026/guiexpert-table/mono
      --name guiexpert` importiert alle Quellcode-, Markdown- und Textdateien des lokalen Checkouts;
      das Ergebnis entspricht inhaltlich dem Import über die Git-URL desselben Commits.
- [ ] `node_modules`, `dist`, Lockfiles, Binärdateien, minifizierte Dateien und alles aus
      `.gitignore` (auch aus Unterverzeichnissen) werden nicht importiert; `.env*` und Schlüsseldateien nie, auch nicht mit
      `--include`.
- [ ] Jeder Code-Chunk hat Pfad, `startLine`/`endLine` und erfüllt alle Chunking-Invarianten;
      Golden-Test für mindestens eine TypeScript- und eine HTML-/Vue-Datei.
- [ ] Chat, Playground und MCP zeigen Quellen als `Pfad:Zeilen`; bei Git-Quellen führt der Link auf
      die richtige Stelle am importierten Commit.
- [ ] Ungültige Pfade (`../x`, absolut, Steuerzeichen), nicht erlaubte Erweiterungen und URLs mit
      Zugangsdaten werden mit dem bestehenden Fehlerformat abgelehnt; nichts davon erscheint in Logs.
- [ ] Bisheriges Verhalten bleibt: `pnpm demo:seed`, Upload in der Web-App, alle bestehenden Tests.
- [ ] **Abnahme mit dem Referenz-Repository** (echte Ollama-Modelle, Fragen auf Englisch): Für
      mindestens diese Fragen liegen unter den Top-Treffern einschlägige Quelltext- oder
      Guide-Stellen, und die Antwort enthält lauffähig wirkenden, aus den Quellen belegten Code:
      1. „How do I have to structure my data so that I can use it as a tree table, and what does the
         code look like?“
      2. „How do I create a pivot table model?“
      3. „How do I write a custom cell renderer?“
      4. „How do I show a footer row with totals?“
      Ergebnis je Frage ehrlich dokumentieren – auch, wenn es nicht überzeugt, mit Analyse
      (Suche oder Chat-Modell?) und Vorschlag für den nächsten Prompt.
- [ ] ADR 0004, Docs und README sind aktualisiert; „Not implemented“ in der README stimmt wieder.

## Tests

- Unit (Node-Test für `scripts/`, Vitest für `apps/*`): Dateiauswahl (ignore-Regeln, Geheimnisse,
  Binärerkennung, Symlinks), Pfadvalidierung, Import-Plan (neu/geändert/gelöscht), Git-URL-Prüfung;
  Code-Chunker (Unit, Golden, Property-Tests mit den bestehenden Invarianten), Sprachzuordnung,
  Prompt-Builder-Snapshot, Zitat-/Link-Bildung.
- Routen-/Integrationstests: Upload mit Pfad, Ablehnung ungültiger Pfade und Typen, Filter nach
  Pfad, Import-Quelle; Injection-Testfall mit Anweisung in einem Code-Kommentar.
- CLI gegen eine API mit Fake-Providern (wie `docker-smoke`/Seed-Tests): Erstimport, zweiter Lauf,
  `--sync`. Git-Klon gegen ein lokal erzeugtes Repository (`file://` nur im Test), kein Netzwerk in CI.
- Web: Komponententests für Pfad-/Zeilenanzeige und Link-Bildung.

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build && pnpm format:check
```

## Dokumentation & Abschluss

- `docs/adr/0004-source-import.md`; `docs/architecture.md`, `docs/data-model.md` (Migration, Pfad,
  Quelle, Chunk-Metadaten), `docs/security.md` (neue Angriffsflächen: Pfade, Git-URLs, Geheimnisse
  im Import, Injection über Code-Kommentare), `docs/evaluation.md`.
- README (Englisch): Features, Abschnitt „Import a directory or repository“ mit Beispiel,
  unterstützte Dateitypen, Grenzen; `docs/local-quickstart.md` anpassen; `.env.example`; CHANGELOG.
- Abschlussbericht gemäß 002 (inkl. Ergebnis der Präfix-Prüfung und der Abnahmefragen); Datei nach
  `prompts/done/` verschieben und die Übersicht in `prompts/README.md` aktualisieren.
