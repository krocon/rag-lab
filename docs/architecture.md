# RAGLab – Architektur

Stand: 2026-11-02 · Status: Grundgerüst (Prompt 001). Was davon implementiert ist, steht in
[Abschnitt 9](#9-implementierungsstand).

RAGLab ist eine self-hosted Workbench, mit der Entwickler Wissenssammlungen aufbauen, indexieren,
semantisch durchsuchen und per Chat mit Quellenangaben abfragen. Schwerpunkt ist eine
**nachvollziehbare, konfigurierbare und testbare RAG-Pipeline** – kein allgemeiner Chat-Client.

Technologieentscheidungen: [ADR 0001](adr/0001-technology-stack.md) · Pipeline-Entscheidungen:
[ADR 0002](adr/0002-rag-pipeline.md) · Datenmodell: [data-model.md](data-model.md)

## 1. Systemkontext

```text
            ┌──────────────────────── Host (Entwickler-Rechner) ───────────────────────┐
 Browser ──▶│  apps/web (Angular)  ──REST/SSE──▶  apps/api (Fastify)  ──SQL──▶  PostgreSQL │
            │   :4200 (dev) / :8080             :3000 /api/*               + pgvector  │
            │                                        │                       :5432     │
            │                                        └──HTTP──▶ Ollama :11434 (nativ)  │
            └──────────────────────────────────────────────────────────────────────────┘
 später:  externe KI-Clients ──MCP (stdio/HTTP)──▶ apps/mcp ──▶ apps/api bzw. Domänendienste
```

| Komponente                     | Verantwortung                                                                             | Nicht-Verantwortung                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `apps/web`                     | UI: Knowledge Bases, Chat, Retrieval Playground, Settings; zeigt Status, Quellen, Scores  | Keine Geschäftslogik, keine direkten Provider- oder DB-Zugriffe         |
| `apps/api`                     | REST + SSE, Validierung, Ingestion, Chunking, Embedding-Aufrufe, Retrieval, Prompt-Aufbau | Keine UI, keine Modellverwaltung (Modelle werden nicht heruntergeladen) |
| PostgreSQL + pgvector          | Single Source of Truth für Metadaten, Text, Chunks und Vektoren                           | –                                                                       |
| Ollama (oder anderer Provider) | Embeddings und Text-Generierung                                                           | Kennt keine RAGLab-Daten außer dem übergebenen Prompt                   |
| `packages/shared`              | Nur TypeScript-Typen (API-Verträge) für API und Web                                       | Kein Laufzeitcode                                                       |

**Systemgrenzen und Vertrauen:** Vertrauenswürdig sind Code, Konfiguration und Systemprompt.
**Nicht vertrauenswürdig** sind hochgeladene Dateien, deren Inhalte (inkl. Chunks im Prompt),
Benutzereingaben und Modellausgaben. Die API ist für den lokalen Betrieb gedacht (Bind auf
`127.0.0.1`, keine Authentifizierung im MVP) und darf in dieser Form nicht öffentlich exponiert werden.

## 2. Monorepo-Struktur

```text
apps/api/            Fastify-API (TypeScript, ESM)
  src/config/        Konfiguration (zod-validiert aus Umgebungsvariablen)
  src/db/            Drizzle-Client, Schema, Migrationsrunner, Readiness-Probe
  src/modules/<m>/   Domänenmodule (aktuell: system)
  drizzle/           SQL-Migrationen (versioniert, von drizzle-kit verwaltet)
  test/              Unit-Tests (vitest), test/integration/ benötigt PostgreSQL
apps/web/            Angular-22-App (Standalone Components, Signals, zoneless)
packages/shared/     Type-only API-Verträge
infra/docker/        Dockerfiles
docs/                Architektur, Datenmodell, ADRs
prompts/             Nummerierte Arbeitsprompts für die Weiterentwicklung
```

## 3. Backend-Module

Module liegen unter `apps/api/src/modules/<name>/` und bestehen aus Routen (HTTP-Schicht mit
JSON-Schema → OpenAPI), Services (Logik, ohne Fastify-Abhängigkeit) und ggf. Repositories (Drizzle).
Abhängigkeiten werden über **Factory-Funktionen und explizite Parameter** verdrahtet
(`buildApp({ config, probe })`), nicht über einen DI-Container – das hält Tests einfach
(`app.inject()` mit Fakes) und vermeidet Framework-Magie.

| Modul         | Aufgabe                                                       | Status               |
| ------------- | ------------------------------------------------------------- | -------------------- |
| `system`      | Liveness, Readiness (DB + pgvector), Konfigurationsinfo       | **implementiert**    |
| `collections` | Knowledge Bases anlegen, listen, umbenennen, löschen          | geplant (Prompt 003) |
| `documents`   | Upload, Metadaten, Status, Löschen                            | geplant (003/004)    |
| `ingestion`   | Text extrahieren (MD/TXT), normalisieren, Hash                | geplant (004)        |
| `chunking`    | Deterministisches Chunking mit Overlap und Herkunftsmetadaten | geplant (005)        |
| `embeddings`  | Provider-Interface, Ollama-Adapter, Dimensionsprüfung         | geplant (006)        |
| `retrieval`   | pgvector-Suche, Collection-Filter, Top-K, Score/Distanz       | geplant (007)        |
| `chat`        | Prompt-Aufbau, Grounding, LLM-Streaming via SSE, Quellen      | geplant (008)        |
| `playground`  | Retrieval-Diagnose (nutzt `retrieval`, liefert Rohdaten)      | geplant (011)        |

Regel: Module greifen nur über exportierte Service-Funktionen aufeinander zu, nie auf fremde Tabellen
direkt. `chat` und `playground` nutzen denselben `retrieval`-Service, damit der Playground exakt zeigt,
was der Chat verwendet.

## 4. Datenfluss

### 4.1 Indexierung (Upload → durchsuchbar)

```text
POST /api/collections/:id/documents (multipart)
  1. validieren: Dateityp (.md/.txt), Größe, Encoding UTF-8      → 400/413/415 bei Verstoß
  2. Document anlegen (status=pending), SHA-256 des Inhalts       → Duplikat-Erkennung pro Collection
  3. ingestion: Text normalisieren (Zeilenenden, BOM, Whitespace)  status=processing
  4. chunking: Chunks mit chunk_index, Offsets, Überschriftenpfad
  5. embeddings: Batches an den Provider, Dimension prüfen
  6. Chunks + Vektoren in einer Transaktion speichern              status=ready
     Fehler in 3–6                                                  status=failed, error_message
```

Die Verarbeitung läuft im MVP **im API-Prozess asynchron** nach der Upload-Antwort (`202 Accepted`);
der Status ist per Polling abrufbar. Eine Job-Queue wird erst eingeführt, wenn Volumen oder
Wiederaufnahme nach Neustart es erfordern (Dokumente in `processing` werden beim Start auf `failed`
mit Hinweis gesetzt, damit nichts unbemerkt hängen bleibt).

### 4.2 Frage → Antwort

```text
POST /api/chat (SSE)  { collectionId, question, topK? }
  1. Frage einbetten (gleicher Provider/Modell wie bei der Indexierung)
  2. retrieval: Top-K Chunks per Cosinus-Distanz, gefiltert nach collection_id in SQL
  3. Prompt aufbauen: Systemanweisung | Quellen als nummerierte, abgegrenzte Daten | Frage
  4. LLM-Stream → SSE-Events: `sources` (vorab), `token`*, `done` | `error`
  5. Antwort referenziert Quellen als [n]; n ↔ (documentId, chunkId) aus Schritt 2
```

Quellen werden **vor** dem ersten Token gesendet, damit das UI sie unabhängig von der Modellausgabe
korrekt anzeigen kann. Zitate, die nicht zu einer gelieferten Quelle passen, werden im UI nicht
verlinkt.

## 5. Provider-Abstraktion

```ts
interface EmbeddingProvider {
  readonly id: string; // z. B. 'ollama'
  readonly model: string; // aus Konfiguration
  readonly dimensions: number; // aus Konfiguration, beim Start verifiziert
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

interface ChatProvider {
  readonly id: string;
  readonly model: string;
  stream(messages: ChatMessage[], signal?: AbortSignal): AsyncIterable<string>;
}
```

- Auswahl über `EMBEDDING_PROVIDER` / `CHAT_PROVIDER`; Modellnamen, Dimension, URLs nur aus der
  Konfiguration ([`.env.example`](../.env.example)).
- Ollama wird per `fetch` gegen die REST-API angesprochen (`/api/embed`, `/api/chat`) – keine
  zusätzliche SDK-Abhängigkeit.
- **Dimensionsprüfung:** Konfiguration (`EMBEDDING_DIMENSIONS`), tatsächliche Provider-Ausgabe und
  Datenbankspalte (`vector(n)`) müssen übereinstimmen. Abweichung → Readiness `not_ready` bzw.
  Indexierungsfehler mit klarer Meldung, niemals stilles Abschneiden oder Auffüllen.
- Cloud-Adapter (z. B. OpenAI-kompatibel) sind spätere, optionale Implementierungen desselben
  Interfaces.

## 6. Konfiguration und Betrieb

- Alle Einstellungen über Umgebungsvariablen, validiert mit zod beim Start (`src/config/env.ts`);
  ungültige Konfiguration beendet den Prozess mit einer Liste aller Fehler.
- Lokale Entwicklung lädt die Root-`.env`; bereits gesetzte Variablen (Docker, CI) haben Vorrang.
- Health: `GET /api/health` (Liveness, ohne Abhängigkeiten) und `GET /api/health/ready`
  (Readiness: DB erreichbar, pgvector installiert; `503` sonst).
- Logs: strukturiert (pino, JSON) mit Request-ID; keine Dokumentinhalte oder Secrets in Logs.
- OpenAPI 3.1 wird aus den Routen-Schemas generiert: `/api/docs` (UI), `/api/docs/json`.

## 7. Fehlerfälle

| Situation                                | Verhalten                                                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Ungültige/fehlende Konfiguration         | Start bricht ab, alle Fehler werden aufgelistet                                                                             |
| DB nicht erreichbar                      | Liveness `200`, Readiness `503`; Requests mit DB-Bedarf → `503`                                                             |
| pgvector fehlt                           | Readiness `503` mit Hinweis auf `pnpm db:migrate`                                                                           |
| Provider nicht erreichbar / Modell fehlt | Indexierung → Dokument `failed` mit Meldung; Chat → SSE-`error`-Event                                                       |
| Dimension passt nicht                    | Readiness `not_ready`, Indexierung verweigert                                                                               |
| Keine oder schwache Treffer              | Chat sagt offen, dass die Quellen keine Antwort enthalten; kein LLM-Aufruf ohne Kontext, wenn die Frage dokumentbasiert ist |
| Upload ungültig (Typ, Größe, Encoding)   | `400`/`413`/`415` mit maschinenlesbarem Fehlercode                                                                          |
| Client bricht SSE ab                     | Provider-Request wird per `AbortSignal` abgebrochen                                                                         |

Fehlerantworten folgen einem einheitlichen Format `{ error: { code, message, details? } }`
(Einführung mit Prompt 003).

## 8. Sicherheit

- **Prompt-Injection:** Dokumentinhalte sind Daten. Sie werden im Prompt klar abgegrenzt
  (nummerierte Quellenblöcke mit Begrenzern), der Systemprompt weist an, Anweisungen in Quellen zu
  ignorieren. Das **verhindert Prompt-Injection nicht vollständig** – Restrisiko: manipulierte
  Antworten. Gegenmaßnahmen: keine Tools/Aktionen für das Modell im MVP, Antworten immer mit
  sichtbaren Quellen, Hinweis im UI. Details in [ADR 0002](adr/0002-rag-pipeline.md).
- **Uploads:** Allowlist für Typen, Größenlimit, nur Text, keine Ausführung, kein Speichern
  unter benutzerdefinierten Pfaden (Inhalt liegt in der DB).
- **Rendering:** Modellausgaben und Dokumentinhalte werden im UI als Text bzw. sanitisiertes Markdown
  gerendert (Angulars Sanitizer, kein `bypassSecurityTrust*`).
- **Netzwerk:** API und DB binden lokal (`127.0.0.1`), CORS-Allowlist über `CORS_ORIGINS`.
- **Secrets:** nur über Umgebungsvariablen, `.env` ist git-ignoriert, `/api/system/info` liefert keine
  URLs oder Zugangsdaten.
- Rate Limits, Security-Header und Upload-Härtung: Prompt 012.

## 9. Implementierungsstand

| Bereich                                                                               | Stand                                                        |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Monorepo (pnpm Workspaces), TS strict, ESLint, Prettier                               | ✅ implementiert                                             |
| PostgreSQL 18 + pgvector 0.8.7 per Docker Compose, Health Check, Volume               | ✅ implementiert                                             |
| Migration 0000 (`CREATE EXTENSION vector`), Migrationsrunner                          | ✅ implementiert, integrationsgetestet                       |
| API: Liveness, Readiness, System-Info, OpenAPI, CORS, Konfigurationsvalidierung       | ✅ implementiert, getestet                                   |
| Web: Shell mit Navigation, Welcome-Seite mit Live-Status, Settings (read-only), Theme | ✅ implementiert, getestet                                   |
| Dockerfiles (API, Web), CI-Workflow                                                   | ✅ vorhanden                                                 |
| Collections, Upload, Chunking, Embeddings, Retrieval, Chat, Playground                | ⏳ geplant – siehe [prompts/README.md](../prompts/README.md) |
| MCP-Server                                                                            | ⏳ geplant (Prompt 014), nicht Teil des MVP                  |
