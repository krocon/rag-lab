# RAGLab – Arbeitsprompts

Dieses Verzeichnis enthält die nummerierte Prompt-Serie, mit der RAGLab schrittweise entwickelt wird.
Jeder Prompt kann einem Coding-Agenten (Claude Code, Codex o. ä.) direkt übergeben werden: Er erklärt
den Projektkontext, verlangt zuerst eine Untersuchung des vorhandenen Codes, nennt konkrete Dateien,
Endpunkte und Tabellen, grenzt den Umfang ab und definiert Akzeptanzkriterien und Tests.

## Konventionen

- **Benennung:** dreistellig fortlaufend `NNN-kurzname.md` (Entscheidung in
  [`docs/00-bestandsaufnahme.md`](../docs/00-bestandsaufnahme.md), Abschnitt 5).
- **Projektregeln und Definition of Done** stehen zentral in
  [`002-project-bootstrap.md`](002-project-bootstrap.md); alle anderen Prompts verweisen darauf.
- **Erledigte Prompts** werden nach [`done/`](done/) verschoben (`git mv`), sobald ihre
  Definition of Done erfüllt ist, und der Status unten wird aktualisiert. Links in Dokumenten, die auf
  einen Prompt zeigen, beim Verschieben mit anpassen.
- Prompts sind Arbeitsdokumente (Deutsch); Code, API und öffentliche Repository-Dateien sind Englisch.
- Weicht die Umsetzung begründet von einem Prompt ab, wird das in den Docs und im Abschlussbericht
  festgehalten – der Prompt selbst wird nach Abschluss nicht mehr umgeschrieben.

## Bootstrap

`001` und `002` bilden das Bootstrap: [`001-RAGLab-Initialprojekt-Prompt.md`](done/001-RAGLab-Initialprojekt-Prompt.md)
ist der ursprüngliche Initialprompt (im ersten Durchlauf ausgeführt: Bestandsaufnahme, Architektur,
Monorepo-Grundgerüst, Compose, Health-Endpunkte, Angular-Shell, diese Prompt-Serie). `002` ist seine
kompakte, wiederverwendbare Form mit den verbindlichen Projektregeln und kann als Gesundheitscheck des
Grundgerüsts ausgeführt werden.

## Übersicht

| Nr. | Datei | Ziel | Abhängig von | Ergebnis | Status |
|---|---|---|---|---|---|
| 001 | [001-RAGLab-Initialprojekt-Prompt.md](done/001-RAGLab-Initialprojekt-Prompt.md) | Initiales Projekt- und Architektur-Setup | – | Architektur-Docs, Monorepo, Compose, API/Web-Grundgerüst, Prompt-Serie | ✅ erledigt |
| 002 | [002-project-bootstrap.md](002-project-bootstrap.md) | Kompaktes Bootstrap + Projektregeln | 001 | Verbindliche Regeln/DoD; geprüftes, grünes Grundgerüst | offen (Referenz) |
| 003 | [003-database-domain-model.md](003-database-domain-model.md) | Datenmodell, Migrationen, Collections-CRUD | 002 | Tabellen `collections`/`documents`/`chunks`, HNSW-Index, Fehlerformat, `/api/collections` | offen |
| 004 | [004-document-ingestion.md](004-document-ingestion.md) | Upload MD/TXT, Extraktion, Normalisierung, Status | 003 | `POST /api/collections/:id/documents` (202), Duplikaterkennung, Indexer-Gerüst | offen |
| 005 | [005-chunking-pipeline.md](005-chunking-pipeline.md) | Deterministisches Chunking mit Metadaten | 004 | Chunker mit Offsets/Überschriftenpfad, `GET /api/documents/:id/chunks` | offen |
| 006 | [006-embedding-providers.md](006-embedding-providers.md) | Embedding-Interface, Ollama-Adapter, Dimensionsprüfung | 005 | Vektoren in `chunks.embedding`, Reindex, `/api/system/providers` | offen |
| 007 | [007-vector-retrieval.md](007-vector-retrieval.md) | pgvector-Suche mit Collection-Filter, Top-K, Scores | 006 | Retrieval-Service, `POST /api/retrieval/search` (`distance`/`score`) | offen |
| 008 | [008-rag-chat-streaming.md](008-rag-chat-streaming.md) | Grounded Prompt, Quellen, SSE-Streaming | 007 | `ChatProvider`, Prompt-Builder, `POST /api/chat` (SSE) | offen |
| 009 | [009-angular-knowledge-ui.md](009-angular-knowledge-ui.md) | Knowledge-Base-UI, Upload, Statusanzeige | 006 (008 empfohlen) | `/knowledge-bases`, Collection-Detail, Dokument-/Chunk-Ansicht | offen |
| 010 | [010-angular-chat-ui.md](010-angular-chat-ui.md) | Chat-UI mit Streaming und Quellen | 008, 009 | `/chat` mit SSE-Client, Quellenkarten, Zitat-Links, Fehlerzustände | offen |
| 011 | [011-retrieval-playground.md](011-retrieval-playground.md) | Retrieval-Diagnose | 007, 008, 009 (010 empfohlen) | `POST /api/playground/search`, `/playground` mit Scores, Chunk- und Prompt-Vorschau | offen |
| 012 | [012-security-and-hardening.md](012-security-and-hardening.md) | Validierung, Upload-Sicherheit, Prompt-Injection, Secrets, CORS, Rate Limits, Header | 008 (011 empfohlen) | Gehärtete API, `docs/security.md`, Bedrohungsmodell | offen |
| 013 | [013-test-and-evaluation.md](013-test-and-evaluation.md) | Testdaten, Recall@K/MRR, reproduzierbare Läufe | 008 (012 empfohlen) | Eval-Datensatz, `pnpm eval`, CI-Smoke-Eval, Injection-Testfall, `docs/evaluation.md` | offen |
| 014 | [014-mcp-server.md](014-mcp-server.md) | MCP-Server mit vier lesenden Tools | 008 (012, 013 empfohlen) | `apps/mcp` (stdio), `list_collections`, `search_knowledge`, `get_document`, `ask_knowledge`, ADR 0003 | offen |
| 015 | [015-docker-ci-release.md](015-docker-ci-release.md) | Produktionsnahe Container, CI, Versionierung | 012 (013, 014 empfohlen) | Non-root-Images, Migrations-Service, CI-Jobs, Release-Workflow, CHANGELOG | offen |
| 016 | [016-documentation-and-demo.md](016-documentation-and-demo.md) | README, Screenshots, Demo-Datensatz, Video-Drehbuch | 015 (mind. 011) | Konsolidierte Docs, `pnpm demo:seed`, `docs/demo/video-script.md` | offen |

## Empfohlene Reihenfolge

```text
001 ✅ → 002 (optional, Regeln lesen) → 003 → 004 → 005 → 006 → 007 → 008
      → 009 → 010 → 011 → 012 → 013 → 014 → 015 → 016
```

- **Nächster empfohlener Prompt: [`003-database-domain-model.md`](003-database-domain-model.md).**
  `002` muss nicht separat ausgeführt werden, wenn das Grundgerüst grün ist – seine Projektregeln
  gelten trotzdem für jeden Prompt.
- 003–008 bilden den Backend-Pfad und bauen strikt aufeinander auf.
- 009 kann nach 006 parallel zu 007/008 bearbeitet werden; 010 und 011 brauchen 008.
- Ab 012 sind die Prompts weitgehend unabhängig voneinander, die Reihenfolge oben minimiert aber
  Nacharbeit (z. B. nutzt 015 die Tests aus 013 und ggf. `apps/mcp` aus 014).

## Zwischenstände, die bewusst sichtbar bleiben

- Nach 004 bleiben neue Dokumente `pending`, bis 005 den ersten Indexierungsschritt liefert.
- Nach 005 bedeutet `ready` „gechunkt, noch ohne Embeddings“; ab 006 bedeutet `ready` „gechunkt und
  eingebettet“. Beide Zwischenstände werden in `docs/architecture.md` §9 dokumentiert, nicht kaschiert.
