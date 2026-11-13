# ADR 0004 – Quellcode-Import aus lokalem Verzeichnis oder Git-Repository

- Status: akzeptiert (umgesetzt mit Prompt 017)
- Datum: 2026-11-11

## Kontext

Bis Version 0.1.0 indexiert RAGLab nur einzeln hochgeladene Markdown- und Textdateien; gespeichert
wird nur der letzte Teil des Dateinamens, und es gibt die Chunking-Formate `markdown` und `text`.
Nutzer wollen aber ein ganzes Projekt einlesen, also ein lokales Verzeichnis oder eine Git-URL
**einschließlich Quellcode**, und Fragen wie „How do I have to structure my data so that I can use
it as a tree table, and what does the code look like?“ mit Quellen beantwortet bekommen, die als
**Pfad und Zeilenbereich** zitiert werden.

Randbedingungen: Die API ist ein lokaler Dienst ohne Authentifizierung (security.md §1). Sie liest
keine beliebigen Pfade und holt keine fremden URLs. Die Images laufen als non-root und read-only
(Prompt 015). Der MCP-Server spricht die API ausschließlich per HTTP an (ADR 0003). Das
Upload-Format ist „alles oder nichts“ pro Anfrage, mit Limits und Rate Limits aus Prompt 012.

## Entscheidungen

1. **Der Import läuft als Client (`pnpm kb:import`) auf dem Rechner des Nutzers, nicht im
   API-Server.** `scripts/kb-import.mjs` und `scripts/kb/*.mjs` lesen das Verzeichnis, filtern und
   laden die Dateien über die öffentliche REST-API hoch, genau wie `demo:seed`. Für eine Git-URL
   klont das CLI mit dem lokal installierten `git` flach in ein temporäres Verzeichnis und räumt
   es in jedem Fall wieder auf.
2. **Relativer Pfad je Dokument** als neue Spalte `documents.path` (nullable, eindeutig pro
   Collection über einen partiellen Unique-Index, max. 512 Zeichen). Der Client sendet ihn als
   Formularfeld `path` direkt vor dem Datei-Part. Der Server validiert streng (`400 INVALID_PATH`)
   und verwendet ihn nie als Dateisystempfad. Der Anzeigename `filename` ist dann das letzte
   Pfadsegment.
3. **Import-Quelle je Collection** als `collections.source` (jsonb: `kind`, `url`, `ref`,
   `commit`, `importedAt`), gesetzt über `PUT /api/collections/:id/source`. URLs mit
   Zugangsdaten werden abgelehnt (`400 INVALID_SOURCE`); das CLI entfernt sie vorher.
4. **Allowlist erweitert** um Quellcode, Konfiguration und HTML/CSS
   (`ingestion/file-type.ts`: Erweiterung → MIME-Typ → Sprache). Der Typ wird weiterhin nie vom
   Client übernommen. Die Sprache bestimmt das Chunking-Format: `markdown`, `text`, sonst `code`.
5. **Neues Chunking-Format `code`** (`chunking/code-sections.ts`, deterministisch, ohne Parser):
   Abschnitte an Top-Level-Deklarationen je Sprachfamilie (`export`, `class`, `function`,
   `interface`, `type`, `const … =`, `def`, `func`, `fn`, Top-Level-Tags von Vue/Svelte/Astro/HTML,
   CSS-Regeln, YAML-Schlüssel, SQL-Anweisungen, Shell-Funktionen). Doc-Kommentare und
   (auch mehrzeilige) Decorators gehören zu ihrer Deklaration. Kleine Abschnitte werden
   zusammengelegt, solange sie gemeinsam in einen Chunk passen. Innerhalb eines Abschnitts wird an
   Leerzeilen, dann an Zeilenenden geschnitten, **nie mitten in einer Zeile**. Einzige Ausnahme
   (definierter Fallback): Ist eine einzelne Zeile länger als `CHUNK_SIZE` (minifizierter Code),
   wird an Wortgrenzen, notfalls hart geschnitten. Der Overlap beginnt an einem Zeilenanfang und
   wird so bemessen, dass die nächste Zeile vollständig passt.
6. **Zeilen und Symbol je Chunk** für alle Formate in `chunks.metadata` (`startLine`, `endLine`,
   1-basiert; `symbol` bei Code). Für Code ist `headingPath` gleich `[Pfad, Symbol]`. Alle
   Invarianten aus ADR 0002 §2 gelten unverändert und werden für Code zusätzlich mit
   Property-Tests geprüft.
7. **Kontextkopf fürs Embedding:** Für Dokumente **mit Pfad** wird `File: <path>` plus
   `Symbol: <symbol>` (Code) bzw. `Section: <a > b>` (Markdown) vor den Chunk-Text gesetzt
   (`embeddings/embedding-text.ts`). Der gespeicherte `content` bleibt unverändert. Der Kopf wird
   aus gespeicherten Feldern abgeleitet und im Playground als `embeddingHeader` angezeigt. Dokumente
   ohne Pfad (Web-Upload, `demo:seed`, flache Eval-Datensätze) werden wie bisher eingebettet.
8. **Prompt:** Quellenblöcke tragen `path`, `lines`, `language` und `symbol`. Code steht in einem
   Code-Zaun, der länger ist als jede Backtick-Folge im Code. Regel 6 des Systemprompts verlangt
   bei Code-Fragen Antworten aus den Quellen, Beispiele aus oder eng an den Quellen und die
   Nennung fehlender Teile; Kommentare und Strings im Code sind ausdrücklich Daten.
9. **Links auf den Quelltext** baut der Server (`collection-source.ts`, `buildSourceUrl`): nur für
   GitHub, GitLab, Bitbucket und Codeberg, nur mit vollständiger Hex-Commit-SHA, aus validiertem
   `owner/repo` und prozentkodierten Pfadsegmenten. Ergebnis: `sourceUrl` in Retrieval, Chat,
   Playground und MCP.
10. **`pnpm kb:collect` entfällt.** Es war eine Übergangslösung (flache Kopie, Pfad im Dateinamen,
    nur Markdown/Text). `kb:import` deckt alles ab. Die Ideen (Ausschlussverzeichnisse,
    Duplikat-Plan per Hash) sind in `scripts/kb/select-lib.mjs` neu umgesetzt, die Bibliothek
    selbst wurde nicht wiederverwendet, weil flache Dateinamen mit Pfaden überflüssig sind.

## Begründungen

**Client statt Server-Import.** Ein serverseitiger Import müsste beliebige Pfade des
Server-Dateisystems lesen (Path Traversal, Zugriff auf Konfiguration und Secrets im Container) oder
fremde URLs abrufen (SSRF auf interne Dienste, `file://`, `ext::`). Dazu müsste `git` ins Image
(größere Angriffsfläche, Hooks, Submodule, LFS), und die Images wären nicht mehr read-only. Private
Repositories bräuchten Zugangsdaten im Server. Als Client nutzt das CLI die Git-Zugangsdaten des
Nutzers (Credential-Helper, SSH-Agent), ohne dass RAGLab sie je sieht. Es ist dieselbe
Vertrauensgrenze wie beim MCP-Server (ADR 0003): Alles läuft durch die gehärtete REST-API mit
Validierung, Limits und Rate Limits.

**Spalte statt `metadata` für den Pfad.** Eindeutigkeit pro Collection (Grundlage für Idempotenz
und `--sync`), Sortierung und Präfixfilter brauchen einen Index. Ein partieller Unique-Index auf
`(collection_id, path) WHERE path IS NOT NULL` lässt Uploads ohne Pfad unberührt. Die 512 Zeichen
halten den btree-Eintrag sicher unter der Größengrenze von PostgreSQL (≈ 2,7 KB). Der Präfixfilter
nutzt `starts_with()`, damit `%` und `_` wörtlich bleiben.

**Pfad als eigenes Formularfeld.** Busboy entfernt Pfadanteile aus dem Multipart-Dateinamen
(`preservePath: false`), und der Dateiname eines Browser-Uploads ist kein verlässlicher Pfad. Ein
explizites Feld `path` vor dem Datei-Part ist eindeutig. Ohne dieses Feld verhält sich der Upload
genau wie bisher.

**Heuristik statt Tree-sitter.** Tree-sitter bräuchte native oder WASM-Grammatiken je Sprache,
eine schwere Abhängigkeit und Laufzeit im API-Prozess. Die Zeilen-Heuristik ist deterministisch,
linear und für die häufigen Fälle ausreichend: Deklarationen beginnen in Spalte 0. Gegen das
Referenz-Repository (≈ 2.700 Code-Dateien, 67.000 Chunks) verletzt sie keine Invariante und
erkennt bei 78 % der Chunks ein Symbol (≈ 3 s).

**Kontextkopf nur mit Pfad.** Ohne Kopf findet die Vektorsuche einen Chunk wie
`visibleRows(): …` nur über seinen Text. Der Dateipfad (`tree/tree-model.ts`) und das Symbol
(`class TreeTableModel`) tragen oft genau die Begriffe der Frage. Für Dokumente ohne Pfad ändert
sich nichts, damit vorhandene Collections, der Golden-Datensatz der Evaluation und `demo:seed`
vergleichbar bleiben. Der Kopf ist aus gespeicherten Feldern reproduzierbar und braucht deshalb
keine eigene Spalte.

**Nichts löschen ohne `--sync`.** Ein geänderter Pfad lässt sich nur ersetzen, indem das alte
Dokument gelöscht wird (Unique-Index). Ohne `--sync` meldet das CLI geänderte und entfernte
Dateien nur. Mit `--sync` gibt es zuerst eine Zusammenfassung aus, löscht dann und lädt danach
hoch. Dokumente ohne Pfad (Web-Upload) werden nie angefasst.

## Verworfene Alternativen

- **Serverseitiger Import** (Pfad oder URL in der Web-App, Import-Job in der API): verworfen aus
  den oben genannten Sicherheitsgründen. Er bleibt ein möglicher späterer Prompt, dann mit einem
  eigenen, isolierten Worker (eigener Container ohne DB-Zugangsdaten, Allowlist für Hosts,
  Timeouts, Quotas).
- **Pfad im Dateinamen kodieren** (`packages__table__README.md`, bisher `kb:collect`): nicht
  eindeutig rückübersetzbar, keine Präfixfilter, keine Links.
- **Pfad in `documents.metadata`**: ohne Unique-Index, Sortierung und Filter nur mit
  Ausdrucksindex; die Spalte ist einfacher und ehrlicher.
- **AST-Parser (Tree-sitter)**: als Ausblick dokumentiert, siehe unten.
- **Abhängigkeit `ignore` für gitignore-Muster**: Die aktuelle Version war zum Zeitpunkt der
  Umsetzung jünger als zwei Wochen (Supply-Chain-Regel aus security.md §8). Ein eigener, getesteter
  Matcher (`scripts/kb/gitignore.mjs`, ≈ 150 Zeilen) deckt die benötigten Regeln ab.

## Konsequenzen

- Migration `0002_source_import` (Spalten `documents.path`, `collections.source`, Index, Check).
  Bestehende Daten bleiben gültig; ältere Chunks haben keine Zeilennummern (`null`), bis sie
  reindexiert werden.
- Größere Imports stoßen an `RATE_LIMIT_UPLOAD_MAX` (30 Anfragen/min × `MAX_UPLOAD_FILES` 20 =
  600 Dateien/min). Das CLI wartet nach `429` gemäß `Retry-After`. Für einige tausend Dateien sind
  das wenige Minuten, deshalb bleiben die Standardwerte unverändert und die Härtung aus 012 bleibt
  bestehen.
- Neue Angriffsflächen (Pfade, Git-URLs, Geheimnisse im Import, Injection über Code-Kommentare)
  sind in security.md §12 beschrieben.
- **Ausblick:** Tree-sitter für Symbolgrenzen und verschachtelte Symbole; hybride Suche
  (Stichwort + Vektor) und Reranking als voraussichtlich größter nächster Qualitätshebel für Code
  (exakte Bezeichner wie `createPivotModel`); Filter nach Pfadpräfix und Sprache in der Suche;
  Aufgaben-Präfixe für `nomic-embed-text` (`search_query:`/`search_document:`).
