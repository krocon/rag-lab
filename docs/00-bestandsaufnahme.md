# RAGLab – Bestandsaufnahme (Schritt 1)

> **Historisches Dokument.** Diese Bestandsaufnahme beschreibt den Stand **vor** dem ersten Code
> (2026-11-01) und wird bewusst nicht fortgeschrieben. Versionen, Werkzeugbefunde und offene
> Entscheidungen können überholt sein. Aktueller Stand: [architecture.md §9](architecture.md#9-implementierungsstand),
> [README](../README.md) und [CHANGELOG](../CHANGELOG.md).

Stand: 2026-11-01 · Grundlage: `prompts/done/001-RAGLab-Initialprojekt-Prompt.md`, Schritt 1

Dieses Dokument hält fest, was im Repository vorhanden ist, welche Werkzeuge verfügbar sind und welche
Versionen der Kerntechnologien aktuell stabil sind. Es ist die Grundlage für Schritt 2 (Architektur) und
wird dort in `docs/adr/0001-technology-stack.md` überführt.

## 1. Repository-Zustand

| Pfad | Inhalt | Bewertung |
|---|---|---|
| `LICENSE` | **MIT**, © 2026 Marc Kronberg | Existiert bereits – wird **nicht** überschrieben (siehe Offene Entscheidungen) |
| `prompts/001-RAGLab-Initialprojekt-Prompt.md` | Initialprompt (inzwischen nach `prompts/done/` verschoben) | Basis der Arbeit |
| `prompts/done/` | leer | Vermutlich Ablage für erledigte Prompts |
| `.agents/skills/`, `.gemini/skills/` | leer | Platzhalter für Agent-Skills, kein Handlungsbedarf |
| `.idea/` | WebStorm-Projektdateien, untracked | Muss in `.gitignore` |
| Git | Branch `main`, 1 Commit (`Initial commit`), Remote `origin` = `https://github.com/krocon/rag-lab.git` | |

Nicht vorhanden: Code, `package.json`, `.gitignore`, `.editorconfig`, README, Docs, CI, Docker-Konfiguration.
Es gibt also nichts, an dessen Konventionen sich das Grundgerüst anpassen müsste – außer Lizenz und
Prompt-Ablage.

## 2. Verfügbare Werkzeuge

> **Wichtige Einschränkung:** Die Prüfung lief in der Linux-VM des Claude-Desktop-Arbeitsbereichs
> (Ubuntu 22.04, aarch64), in die der Projektordner eingebunden ist – **nicht** direkt auf macOS.
> Was dort fehlt (insbesondere Docker), kann auf dem Mac trotzdem installiert sein.

| Werkzeug | VM-Befund | Annahme / Folge |
|---|---|---|
| Node.js | v22.23.4 | Erfüllt Angular-22-Minimum (`^22.22.3`), Ziel ist aber Node 26 LTS (s. u.) |
| npm | 10.9.9 | npm-Registry erreichbar, Versionen wurden dort geprüft |
| pnpm | nicht installiert | Über `corepack` (0.36.0 vorhanden) aktivierbar; Version per `packageManager` im Root-`package.json` pinnen |
| Docker / Compose | nicht erreichbar | **Auf dem Mac zu prüfen.** Compose-Stack kann in der VM nicht gestartet/getestet werden |
| psql | nicht installiert | Nicht nötig, Zugriff über Container bzw. Node-Treiber |
| Ollama | nicht installiert | Läuft typischerweise nativ auf macOS (Metal-GPU); Compose-Profil nur optional |
| git | 2.34.1 | ok |
| Python | 3.10.12 | nur Hilfsskripte, kein Projektbestandteil |
| gh (GitHub CLI) | nicht installiert | nicht erforderlich |

**Bitte auf dem Mac ausführen** (Ergebnis bestimmt, ob Schritt 4/5 dort voll testbar ist):

```bash
node --version; corepack --version; pnpm --version
docker --version; docker compose version
ollama --version; ollama list
```

### Befund auf dem Mac (Marc, 2026-11-01)

| Werkzeug | Version | Bewertung |
|---|---|---|
| Node.js | v24.21.0 | Erfüllt Angular 22 (`^24.15.0`) und Vitest 5. Node 24 ist Maintenance LTS bis 04/2028 |
| pnpm | 10.25.0 | Funktioniert; Pinning über `packageManager` + Corepack (`corepack enable`) holt die festgelegte Version automatisch |
| Docker Compose | v5.6.0 | Verfügbar → Compose-Stack und DB-Integrationstests lokal testbar |
| Ollama | 0.13.2 | Deutlich älter als aktuell (0.40.12); `/api/embed` ist vorhanden, Update trotzdem empfohlen |
| Ollama-Modelle | keine | Für Embeddings/Chat muss später ein Modell gezogen werden – wird **nicht** ungefragt geladen |

## 3. Aktuelle stabile Versionen (geprüft am 2026-11-01)

Quelle für npm-Pakete: `npm view <paket>` gegen die npm-Registry. Weitere Quellen am Ende.

### Laufzeit & Infrastruktur

| Technologie | Aktuell stabil | Empfehlung für RAGLab |
|---|---|---|
| Node.js | 26.13.0 (Active LTS seit 05/2026), 24.22.2 (Maintenance LTS) | Node 26 LTS für Docker/CI, lokal Node 24 unterstützt (s. Abschnitt 5) |
| pnpm | 12.16.1 | via Corepack, `packageManager: "pnpm@12.16.1"` |
| PostgreSQL | 18 | **PostgreSQL 18** |
| pgvector | 0.8.7 | Image **`pgvector/pgvector:0.8.7-pg18-trixie`** (Version gepinnt) |
| Ollama | 0.40.12 (27.10.2026) | lokaler Default-Provider, nativ auf dem Mac |

### Frontend

| Paket | Version | Hinweis |
|---|---|---|
| `@angular/core` | 22.2.4 | **Angular 22 ist stabil** → keine Abweichung vom Prompt nötig |
| `@angular/cli` / `@angular/build` | 22.2.5 | Builder unterstützt Vitest `^4 \|\| ^5` |
| `typescript` | 7.0.2 latest, **6.0.3** für Angular | **Angular 22 verlangt `typescript >=6.0 <6.1`.** TS 7 ist nicht kompatibel |
| `angular-eslint` | 22.6.0 | |

### Backend & Datenzugriff (Kandidaten für ADR 0001)

| Paket | Version | Einschätzung |
|---|---|---|
| `fastify` | 5.12.7 | Favorit: schlank, schnell, gute TS-Typen, Schema-Validierung, SSE ohne Zusatzframework |
| `@fastify/swagger` / `-ui` | 9.9.2 / 6.1.2 | OpenAPI-Generierung aus Route-Schemas |
| `@nestjs/core` | 12.3.2 | Mehr Struktur/DI, aber deutlich mehr Gewicht für einen MVP |
| `hono` | 4.13.16 | Sehr leicht, OpenAPI-Ökosystem weniger etabliert |
| `express` | 5.3.0 | Kein eingebautes Schema/OpenAPI |
| `drizzle-orm` / `drizzle-kit` | 0.45.4 / 0.31.11 | Favorit: typisiert, SQL-nah, SQL-Migrationen, `vector`-Spaltentyp. 1.0 ist noch RC → 0.45.x nutzen |
| `kysely` | 0.29.8 | Alternative: Query-Builder, Migrationen selbst schreiben |
| `pg` / `postgres` | 8.23.1 / 4.0.0 | Treiber |
| `pgvector` (npm) | 0.3.0 | Hilfsfunktionen für `vector`-Serialisierung |
| `zod` | 4.6.7 | Validierung von Konfiguration und Requests |
| `pino` | 10.4.0 | Strukturiertes Logging (Fastify-Standard) |
| `ollama` (npm) | 0.6.4 | Alternativ direkt `fetch` gegen die REST-API – hält die Abhängigkeit klein |
| `@modelcontextprotocol/sdk` | 1.32.2 | erst für Prompt 12 relevant |

### Qualität

| Paket | Version | Hinweis |
|---|---|---|
| `vitest` | 5.0.5 | Node `^22.12 \|\| ^24 \|\| >=26`; für API **und** Angular nutzbar |
| `eslint` | 10.14.0 | |
| `typescript-eslint` | 8.72.1 | unterstützt `typescript <6.1` → passt zu TS 6.0 |
| `prettier` | 3.9.10 | |

## 4. Erkenntnisse mit Auswirkung auf die Architektur

1. **TypeScript 6.0.x workspace-weit pinnen.** Angular-Compiler und typescript-eslint unterstützen TS 7 noch nicht.
   Eine einheitliche Version im Root vermeidet Versionsdrift zwischen `apps/web` und `apps/api`.
2. **Node 26 LTS** als Zielversion; Node 24 ist seit 20.10.2026 nur noch Maintenance LTS.
3. **pgvector-Limits:** HNSW-Index auf `vector` bis 2.000 Dimensionen (`halfvec` bis 4.000).
   Die Embedding-Dimension muss deshalb in Konfiguration **und** Migration festgelegt und beim Start
   gegen den Provider geprüft werden. Große Cloud-Modelle (z. B. 3.072 Dim.) bräuchten `halfvec`.
4. **Distanz-Operatoren:** `<=>` = Cosinus-*Distanz* (Similarity = `1 - Distanz`), `<->` = L2, `<#>` = *negatives*
   Skalarprodukt. Im Code und UI daher klar zwischen `distance` und `score` unterscheiden.
5. **Docker ist in der Agent-Umgebung nicht verfügbar.** Compose-Dateien können geschrieben und mit
   `docker compose config` nur auf dem Mac validiert werden. API-Integrationstests gegen Postgres brauchen
   entweder Docker auf dem Mac oder einen CI-Service-Container (GitHub Actions).
6. **Ollama nativ statt im Container** auf macOS (Container hat keinen GPU-Zugriff unter Docker Desktop).
   Compose-Profil `ollama` nur als optionale Linux-Variante.

## 5. Entscheidungen (getroffen am 2026-11-01)

1. **Lizenz: MIT bleibt.** Die vorhandene `LICENSE` wird beibehalten; der Prompt-Vorschlag Apache-2.0 entfällt.
   Begründung wird in `docs/adr/0001-technology-stack.md` vermerkt.
2. **Prompt-Benennung: dreistelliges Schema `NNN-…` wie `001-…`.** Die im Initialprompt geforderten Dateien
   `00-…` bis `14-…` werden fortlaufend ab `002` nummeriert (gleiche Reihenfolge, gleiche Namenssuffixe):
   `002-project-bootstrap.md`, `003-database-domain-model.md`, … `016-documentation-and-demo.md`.
   Erledigte Prompts wandern nach `prompts/done/`.
3. **Node-Version:** `engines` = `^24.15.0 || >=26.0.0` (lokal läuft Node 24); Dockerfiles und CI nutzen Node 26 LTS,
   CI testet zusätzlich Node 24.
4. **Ollama:** Update auf aktuelle Version empfohlen; Modellwahl (Embedding + Chat) erfolgt in Prompt `006-embedding-providers.md`.

## 6. Nächster Schritt

Schritt 2 – Architektur festlegen: `docs/architecture.md`, `docs/data-model.md`,
`docs/adr/0001-technology-stack.md`, `docs/adr/0002-rag-pipeline.md`.
Vorläufige Stack-Empfehlung: pnpm Workspaces (ohne Nx/Turborepo) · Angular 22 · Fastify 5 ·
Drizzle ORM + drizzle-kit · PostgreSQL 18 + pgvector 0.8.7 · Ollama · Vitest · ESLint/Prettier · TS 6.0.

## Quellen

- npm-Registry (`npm view`), abgefragt am 2026-11-01
- Node.js-Releases: https://endoflife.date/nodejs
- pgvector (Version, Docker-Tags, Operatoren, Limits): https://github.com/pgvector/pgvector
- Ollama-Releases: https://github.com/ollama/ollama/releases
