# RAGLab – Initialer Projekt- und Architektur-Prompt

> **Zweck:** Diesen Prompt in Claude Code, Codex oder einem vergleichbaren Coding-Agenten im gewünschten neuen Projektverzeichnis ausführen. Der Agent soll das Projekt nicht nur planen, sondern ein lauffähiges Grundgerüst erstellen und die nächsten Arbeitsschritte als eigenständige Prompts unter `/prompts` vorbereiten.

---

## Rolle

Du bist ein erfahrener Staff-/Principal-Software-Engineer, Softwarearchitekt und pragmatischer Open-Source-Maintainer. Du entwickelst ein hochwertiges, lokal ausführbares Open-Source-Produkt mit dem Namen **RAGLab**.

Arbeite selbstständig, aber inkrementell. Triff sinnvolle technische Entscheidungen, dokumentiere sie und vermeide unnötige Komplexität. Implementiere keine großen Features nur als Attrappe. Alles, was du als fertig bezeichnest, muss tatsächlich funktionieren und getestet sein.

## Produktidee

**RAGLab – An open-source RAG workbench for developers.**

RAGLab ist eine self-hosted Workbench, mit der Entwickler eigene Wissenssammlungen aufbauen, indexieren, semantisch durchsuchen und über einen Chat mit Quellenangaben abfragen können. Zusätzlich soll RAGLab transparent machen, wie die RAG-Pipeline arbeitet: Dokumente, Chunks, Embeddings, Retrieval-Ergebnisse, Scores und später Reranking sollen untersuchbar sein.

Das Produkt ist ausdrücklich kein allgemeiner ChatGPT-Klon. Der Schwerpunkt liegt auf einer nachvollziehbaren, konfigurierbaren und testbaren RAG-Pipeline.

### Kernnutzen

- Dokumentationen und Wissensbestände importieren.
- Dokumente in Chunks zerlegen und Embeddings erzeugen.
- Vektor- und später hybride Suche durchführen.
- Fragen anhand der gefundenen Quellen beantworten.
- Antworten mit nachvollziehbaren Quellenverweisen und Textausschnitten ausgeben.
- Retrieval transparent untersuchen und verbessern.
- Lokal und self-hosted betreibbar sein.
- LLM- und Embedding-Provider austauschbar halten.
- Später einen MCP-Server bereitstellen, damit externe KI-Clients auf Knowledge Bases zugreifen können.

## Produktprinzipien

1. **Local-first und self-hostable:** Die Anwendung muss lokal mit Docker Compose startbar sein. Dokumente und Vektoren liegen in der eigenen PostgreSQL-Datenbank.
2. **Provider-neutral:** Keine Geschäftslogik darf direkt von einem einzelnen LLM- oder Embedding-Anbieter abhängen.
3. **Nachvollziehbarkeit:** Antworten müssen auf tatsächlich abgerufene Quellen zurückführbar sein. Keine erfundenen Quellen.
4. **Transparenz:** Retrieval und Indexierung sollen im UI sichtbar und debugbar sein.
5. **Security by design:** Dokumentinhalte sind nicht vertrauenswürdig. Sie dürfen keine Systemanweisungen überschreiben. Berücksichtige Prompt-Injection in importierten Dokumenten.
6. **Gute Entwicklererfahrung:** Klare Struktur, verständliche README, reproduzierbare lokale Umgebung, Tests, Linting und formatierte Commits.
7. **MVP vor Feature-Fülle:** Zunächst einen vollständigen vertikalen Funktionspfad liefern, nicht viele unverbundene Platzhalter.

## Vorgesehener Technologie-Stack

Verwende nach Möglichkeit aktuelle stabile Versionen. Prüfe die im Projekt vorhandenen Versionen und offiziellen Dokumentationen, bevor du Versionen festlegst. Erfinde keine Versionsnummern.

### Frontend
- Angular 22 (falls zum Projektstart stabil und verfügbar; andernfalls aktuelle stabile Angular-Version verwenden und Abweichung dokumentieren)
- TypeScript mit strikten Compiler-Einstellungen
- Angular Signals für lokalen UI-State
- Standalone Components
- Accessible UI nach WCAG 2.2 AA als Ziel
- Responsive Dark-/Light-Theme; zunächst eine konsistente, hochwertige Developer-Tool-Oberfläche

### Backend
- Node.js und TypeScript
- REST API mit OpenAPI-Dokumentation
- Streaming von Chat-Antworten via SSE; WebSocket nur, wenn ein konkreter Bedarf entsteht
- Saubere Modulgrenzen und Dependency Injection dort, wo sie echten Nutzen bringt

### Datenhaltung
- PostgreSQL
- pgvector für Vektorsuche
- SQL-Migrationen
- Dokument-Metadaten und Chunk-Metadaten strukturiert speichern
- Datenbankzugriffe über ein etabliertes, gut typisiertes Tool auswählen und begründen

### KI-Anbindung
- Provider-Interfaces für Embeddings und Chat/Generation
- Mindestens ein lokaler Provider-Pfad, bevorzugt Ollama
- Optional ein Cloud-Provider als späterer Adapter
- Modellnamen, Dimensionen, Kontextgrenzen und Konfiguration nicht hardcodieren
- Prüfen, dass Embedding-Dimension und Datenbankspalte zueinander passen

### Betrieb und Qualität
- Docker Compose für lokale Entwicklung
- Dockerfiles für die benötigten Services
- GitHub Actions für CI
- Unit- und Integrationstests
- ESLint und Prettier
- `.env.example`, keine Secrets im Repository
- Health Checks und aussagekräftige Logs

### Monorepo
Bevorzuge pnpm Workspaces. Wähle nur dann ein zusätzliches Monorepo-Tool, wenn es für den MVP einen klaren Vorteil bietet. Vermeide unnötige Tooling-Komplexität.

## Geplanter MVP-Funktionsumfang

Der MVP soll diese vollständige User Journey ermöglichen:

1. Benutzer startet RAGLab lokal.
2. Benutzer erstellt eine Knowledge Base/Collection.
3. Benutzer importiert mindestens Markdown- und TXT-Dateien.
4. Backend extrahiert Text, speichert Dokument-Metadaten und erzeugt Chunks.
5. Ein konfigurierter Embedding-Provider erzeugt Vektoren.
6. Chunks und Vektoren werden in PostgreSQL/pgvector gespeichert.
7. Benutzer stellt eine Frage im Chat.
8. Backend bettet die Frage ein und sucht passende Chunks.
9. Die gefundenen Chunks werden als klar abgegrenzter, nicht vertrauenswürdiger Kontext an das LLM übergeben.
10. Die Antwort wird gestreamt und enthält Quellenreferenzen.
11. Benutzer kann Quellen öffnen und die verwendeten Textpassagen ansehen.
12. Benutzer kann im Retrieval Playground die Suchergebnisse einer Frage inspizieren.

### MVP bewusst nicht enthalten

- Benutzerverwaltung und Multi-Tenancy
- komplexe Rollen- und Rechteverwaltung
- produktive Cloud-SaaS-Infrastruktur
- Agenten mit autonomen Aktionen
- MCP-Server (als spätere Ausbaustufe vorbereiten, aber noch nicht implementieren)
- OCR und aufwendige PDF-Verarbeitung
- komplexe Workflow-Designer
- automatische Git-Synchronisation
- ausgefeilte Analytics

## Architekturleitlinien

Definiere klare Verantwortlichkeiten und halte die Architektur so einfach wie möglich.

### Vorgeschlagene Domänenmodule

- `collections`: Knowledge Bases verwalten
- `documents`: Upload, Metadaten, Status und Löschung
- `ingestion`: Text extrahieren und normalisieren
- `chunking`: Text in nachvollziehbare Abschnitte aufteilen
- `embeddings`: Provider-Abstraktion und Vektorerzeugung
- `retrieval`: Similarity Search und Retrieval-Ergebnisse
- `chat`: Prompt-Aufbau, LLM-Aufruf und Streaming
- `playground`: Retrieval-Diagnose
- `system`: Health, Konfiguration und Modellstatus

Passe die Modulgrenzen an, wenn eine bessere, begründete Struktur entsteht.

### Wichtige Datenkonzepte

Entwirf mindestens folgende Entitäten und dokumentiere ihre Beziehungen:

- Collection
- Document
- Chunk
- Embedding (kann technisch direkt am Chunk gespeichert werden)
- ChatSession (nur falls für den MVP erforderlich)
- ChatMessage (nur falls für den MVP erforderlich)

Speichere bei Chunks mindestens:
- Collection-/Dokumentreferenz
- Chunk-Index bzw. Reihenfolge
- Textinhalt
- Metadaten wie Dateiname, Überschrift oder Seitenangabe, sofern verfügbar
- Token-/Zeichenumfang, soweit sinnvoll
- Embedding
- Erstellungs- und Aktualisierungszeitpunkt

Quellenreferenzen in Antworten müssen stabile Dokument- und Chunk-IDs verwenden, nicht nur Dateinamen.

### Chunking

Implementiere zunächst eine einfache, deterministische Strategie:
- konfigurierbare Zielgröße
- konfigurierbare Überlappung
- möglichst an Absatz- und Satzgrenzen trennen
- keine leeren Chunks
- stabile Reihenfolge
- Herkunftsmetadaten erhalten

Dokumentiere Grenzen und Trade-offs. Baue noch keinen komplexen semantischen Chunker.

### Retrieval

- Top-K muss konfigurierbar sein.
- Similarity-Metrik und Operator müssen zur pgvector-Konfiguration passen.
- Scores bzw. Distanzen müssen eindeutig benannt und korrekt interpretiert werden.
- Leere oder schwache Treffer müssen sauber behandelt werden.
- Collection-Filter müssen bereits bei der Datenbankabfrage angewendet werden.
- Retrieval-Ergebnisse müssen für den Playground nachvollziehbar sein.

### Prompting und Grounding

- Trenne Systemanweisungen, Benutzerfrage und abgerufene Dokumentpassagen klar.
- Behandle Dokumentpassagen als nicht vertrauenswürdige Daten.
- Weise das Modell an, nur auf Basis der bereitgestellten Quellen zu antworten, wenn die Frage eine dokumentbasierte Antwort verlangt.
- Wenn die Quellen keine ausreichende Antwort enthalten, soll das Modell dies offen sagen.
- Quellenreferenzen müssen aus den tatsächlich verwendeten Retrieval-Ergebnissen stammen.
- Keine Behauptung, das Modell könne Prompt-Injection vollständig verhindern. Dokumentiere Restrisiken.

## UX-/UI-Richtung

Entwickle eine moderne, reduzierte Oberfläche für Entwickler. Keine überladenen Dashboards und keine unnötigen Animationen.

Hauptnavigation:
- **Knowledge Bases**
- **Chat**
- **Retrieval Playground**
- **Settings**

Erste Screens:
1. Empty State / Welcome
2. Knowledge-Base-Übersicht
3. Collection-Detail mit Dokumentliste und Indexierungsstatus
4. Chat mit Quellen-Sidebar oder Quellenkarten
5. Retrieval Playground mit Query, Top-K-Ergebnissen, Score und Chunk-Vorschau
6. Settings für Provider und Modellkonfiguration

Achte auf:
- Tastaturbedienbarkeit
- sichtbare Fokuszustände
- semantische HTML-Struktur
- ausreichende Kontraste
- verständliche Lade-, Fehler- und Empty-States
- keine rein farbliche Kennzeichnung von Status

## Open-Source- und Repository-Anforderungen

Erstelle:
- `README.md` mit Produktbeschreibung, Features, Architekturüberblick und Quick Start
- `LICENSE` (Apache-2.0, sofern keine andere Lizenzentscheidung begründet wird)
- `CONTRIBUTING.md`
- `CODE_OF_CONDUCT.md` (Contributor Covenant)
- `SECURITY.md`
- `.gitignore`
- `.editorconfig`
- `.env.example`
- `docker-compose.yml`
- CI-Workflow
- aussagekräftige Architekturentscheidungen unter `docs/adr/`

Erstelle keine erfundenen Badges, Release-Links oder URLs. Verwende Platzhalter nur deutlich gekennzeichnet.

## Arbeitsweise – verbindlich

1. **Repository zuerst untersuchen.** Falls bereits Dateien oder Code existieren, nichts ungeprüft überschreiben. Passe dich dem vorhandenen Zustand an.
2. **Entscheidungen begründen.** Erstelle eine kurze Architektur- und Technologieentscheidung in `docs/`.
3. **Implementiere einen vertikalen Slice.** Am Ende muss mindestens die lokale Infrastruktur starten und ein erster getesteter Backend-/Frontend-Pfad vorhanden sein.
4. **Tests ausführen.** Führe alle relevanten Tests, Linter und Builds aus. Behebe Fehler, statt sie nur zu dokumentieren.
5. **Keine Attrappen.** Nicht implementierte Funktionen klar als geplant markieren. Keine Fake-Daten als echte Funktion ausgeben.
6. **Keine unnötigen Rückfragen.** Triff reversible Entscheidungen selbst. Frage nur, wenn eine Entscheidung den Produktumfang oder eine irreversible Aktion wesentlich verändert.
7. **Dokumentiere den Zustand.** Halte fest, was tatsächlich funktioniert, was offen ist und wie weitergearbeitet wird.
8. **Arbeite in kleinen, nachvollziehbaren Schritten.** Keine riesigen, unübersichtlichen Änderungen.

## Aufgaben für diesen ersten Prompt

Führe jetzt diese Schritte aus:

### Schritt 1 – Bestandsaufnahme
- Untersuche das Arbeitsverzeichnis und vorhandene Projektdateien.
- Prüfe Node.js, pnpm, Docker und relevante verfügbare Tools.
- Prüfe aktuelle stabile Versionen und offizielle Dokumentation für die Kerntechnologien, soweit Internetzugriff verfügbar ist.
- Falls etwas nicht verfügbar ist, kennzeichne die Annahme.

### Schritt 2 – Architektur festlegen
Erstelle:
- `docs/architecture.md`
- `docs/data-model.md`
- `docs/adr/0001-technology-stack.md`
- `docs/adr/0002-rag-pipeline.md`

Beschreibe Systemgrenzen, Datenfluss, Provider-Abstraktionen, Datenmodell, Fehlerfälle und Sicherheitsaspekte.

### Schritt 3 – Repository-Grundgerüst
Lege eine nachvollziehbare Monorepo-Struktur an, beispielsweise:

```text
raglab/
├── apps/
│   ├── web/                 # Angular application
│   └── api/                 # Node.js TypeScript API
├── packages/
│   └── shared/              # Shared contracts/types, wenn sinnvoll
├── prompts/                 # Folgeprompts für die Projektentwicklung
├── docs/
│   ├── adr/
│   ├── architecture.md
│   └── data-model.md
├── infra/
│   └── docker/
├── .github/
│   └── workflows/
├── docker-compose.yml
├── pnpm-workspace.yaml
├── package.json
├── .env.example
├── README.md
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── SECURITY.md
└── LICENSE
```

Passe die Struktur an begründete technische Entscheidungen an.

### Schritt 4 – Lokale Infrastruktur
- PostgreSQL mit pgvector in Docker Compose bereitstellen.
- Health Check einrichten.
- Persistentes Volume verwenden.
- Zugangsdaten ausschließlich über Umgebungsvariablen konfigurieren.
- Eine reproduzierbare Datenbankinitialisierung bzw. Migration bereitstellen.
- Optional Ollama als Compose-Profil oder separat dokumentierten Dienst vorbereiten. Lade nicht ungefragt große Modelle herunter.

### Schritt 5 – Minimalen technischen Durchstich implementieren
- API-Grundgerüst mit Health Endpoint.
- Angular-Grundgerüst mit sauberer Navigation und Welcome-/Empty-State.
- Datenbankverbindung und erste Migration.
- Gemeinsame Typen nur dort, wo sie tatsächlich gebraucht werden.
- Beispielkonfiguration und Startanleitung.
- Tests für Health Endpoint und grundlegende Konfiguration.

Noch keine vollständige RAG-Pipeline erzwingen, wenn das Grundgerüst dafür erst stabil sein muss.

### Schritt 6 – Folgeprompts erstellen

Erstelle unter `/prompts` eine nummerierte, in sich verständliche Prompt-Serie. Jeder Prompt muss einem Coding-Agenten direkt übergeben werden können, den Projektkontext kurz erklären, konkrete Dateien/Features benennen, Akzeptanzkriterien enthalten und Tests verlangen.

Erstelle mindestens folgende Dateien:

1. `prompts/00-project-bootstrap.md` – Dieser initiale Prompt in kompakter, wiederverwendbarer Form und mit Verweis auf die Projektregeln.
2. `prompts/01-database-domain-model.md` – Datenmodell, Migrationen, Collections, Documents und Chunks.
3. `prompts/02-document-ingestion.md` – Markdown-/TXT-Upload, Extraktion, Normalisierung, Status und Fehlerbehandlung.
4. `prompts/03-chunking-pipeline.md` – deterministisches Chunking, Metadaten und Tests.
5. `prompts/04-embedding-providers.md` – Provider-Interfaces, Ollama-Adapter und optional Cloud-Adapter, Dimensionsprüfung.
6. `prompts/05-vector-retrieval.md` – pgvector-Suche, Collection-Filter, Top-K, Scores und Retrieval-Service.
7. `prompts/06-rag-chat-streaming.md` – Prompt-Aufbau, Grounding, Quellenreferenzen und SSE-Streaming.
8. `prompts/07-angular-knowledge-ui.md` – Knowledge-Base-Übersicht, Collection-Detail, Upload und Statusanzeigen.
9. `prompts/08-angular-chat-ui.md` – Chat, Streaming, Quellenanzeige und Fehlerzustände.
10. `prompts/09-retrieval-playground.md` – Suchdiagnose, Treffer, Scores und Chunk-Vorschau.
11. `prompts/10-security-and-hardening.md` – Validierung, Upload-Sicherheit, Prompt-Injection-Risiken, Secrets, CORS und Rate Limits.
12. `prompts/11-test-and-evaluation.md` – Testdaten, Retrieval-Evaluierung, Recall@K/MRR soweit angemessen und reproduzierbare Testläufe.
13. `prompts/12-mcp-server.md` – separater MCP-Server mit `search_knowledge`, `ask_knowledge`, `get_document` und `list_collections`.
14. `prompts/13-docker-ci-release.md` – Produktionsnahe Docker-Konfiguration, GitHub Actions, Versionierung und Release-Vorbereitung.
15. `prompts/14-documentation-and-demo.md` – README, Screenshots, Demo-Datensatz und Video-Drehbuch.

Lege zusätzlich `prompts/README.md` mit der empfohlenen Reihenfolge, Abhängigkeiten und dem jeweiligen Ergebnis jedes Prompts an.

Die Folgeprompts sollen nicht blind alle Features gleichzeitig implementieren. Sie müssen aufeinander aufbauen und den vorhandenen Code zuerst untersuchen. Jeder Prompt soll den Agenten anweisen, bestehende Konventionen zu respektieren und Dokumentation/Tests aktuell zu halten.

### Schritt 7 – Abschlussbericht
Gib am Ende eine kompakte Zusammenfassung mit:
- angelegter Repository-Struktur
- getroffenen Architekturentscheidungen
- tatsächlich implementierten Funktionen
- ausgeführten Tests und deren Ergebnis
- Startbefehlen
- offenen Punkten und bekannten Einschränkungen
- empfohlenem nächsten Prompt (mit Dateipfad)

## Definition of Done für diesen initialen Durchlauf

Der erste Durchlauf ist abgeschlossen, wenn:

- die Architektur dokumentiert ist,
- das Monorepo-Grundgerüst existiert,
- PostgreSQL/pgvector per Docker Compose konfiguriert ist,
- API und Angular-App als Grundgerüst vorhanden sind,
- mindestens ein Health-/Smoke-Test existiert und erfolgreich läuft,
- `.env.example` vorhanden ist,
- alle oben genannten Folgeprompts erstellt wurden,
- `prompts/README.md` die Reihenfolge erklärt,
- die Haupt-README einen nachvollziehbaren Quick Start enthält,
- keine nicht implementierte Funktion als fertig dargestellt wird.

**Wichtig:** Beginne jetzt mit der Bestandsaufnahme und arbeite die Schritte in dieser Reihenfolge ab. Beende die Arbeit nicht nach einer bloßen Planung. Erstelle und prüfe die Dateien tatsächlich.
