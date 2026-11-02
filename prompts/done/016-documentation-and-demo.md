# 016 – Dokumentation & Demo (README, Screenshots, Demo-Datensatz, Video-Drehbuch)

## Kontext

RAGLab ist eine self-hosted, open-source RAG-Workbench für Entwickler. Nach 003–015 sind
Funktionsumfang (Collections, Upload, Chunking, Embeddings, Retrieval, Chat mit Quellen,
Playground, ggf. MCP-Server), Härtung, Evaluierung, Docker und CI vorhanden. Die Dokumentation ist
über die Prompts gewachsen und muss für Erstnutzer, Contributors und eine öffentliche Vorstellung
konsolidiert werden.

Dieser Prompt erstellt eine überzeugende, **ehrliche** Außendarstellung: README, echte Screenshots,
einen Demo-Datensatz mit Seed-Skript und ein Video-Drehbuch.

**Voraussetzungen:** 002–015 erledigt (mindestens der MVP-Pfad 003–011).

## Zuerst untersuchen

- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `docs/**` (Architektur,
  Datenmodell, ADRs, security, evaluation, release), `prompts/README.md`.
- Tatsächlich implementierte Funktionen: `docs/architecture.md` §9, OpenAPI unter `/api/docs`,
  Routen der Web-App, `apps/mcp` (falls vorhanden). **Nur dokumentieren, was existiert.**
- Eval-Datensatz aus 013 (`eval/datasets/`) – prüfen, ob er als Demo-Datensatz taugt oder ein eigener
  sinnvoller ist.
- `.env.example`, `docker-compose.yml`, Root-Skripte.

## Ziele

1. **README.md (Englisch)** neu strukturieren:
   Pitch (1–2 Sätze, „not a ChatGPT clone“), Screenshot oben, Features (nur implementierte; geplante
   separat und gekennzeichnet), „How it works“ (Pipeline-Diagramm als Mermaid oder ASCII: Upload →
   Normalize → Chunk → Embed → pgvector → Retrieve → Grounded prompt → Streamed answer with sources),
   Quick Start (Docker-Variante und Dev-Variante, Ollama-Modelle als Benutzerschritt), Konfiguration
   (Tabelle der wichtigsten Variablen, Verweis auf `.env.example`), Retrieval-Transparenz
   (`distance` vs. `score`), Evaluation, MCP (falls vorhanden), Security & Limitations
   (Prompt-Injection-Restrisiko, kein Auth – nicht öffentlich exponieren), Projektstruktur,
   Contributing, License (MIT). Keine erfundenen Badges, URLs oder Zahlen; Badges nur, wenn sie auf
   existierende Workflows zeigen.
2. **Screenshots** in `docs/images/` (PNG/WebP, optimiert, sprechende Namen): Welcome, Knowledge-Base-
   Übersicht, Collection-Detail mit Status, Chat mit Quellen, Playground mit Scores, Settings; Light und
   mindestens ein Dark-Screenshot. **Echte Screenshots der laufenden App** mit dem Demo-Datensatz – keine
   Mockups. Alt-Texte in der README. Falls im Agent-Umfeld kein Browser verfügbar ist: Skript bzw.
   genaue Anleitung zur Erstellung liefern und im Bericht als offen markieren, statt Bilder zu erfinden.
3. **Demo-Datensatz** `examples/demo-knowledge-base/` (Englisch, selbst verfasst, lizenzfrei, keine
   realen Personen/Firmen): z. B. Dokumentation eines fiktiven Open-Source-Tools (Installation,
   Konfiguration, FAQ, Troubleshooting, Changelog) mit 8–15 Markdown/TXT-Dateien, Überschriften-
   struktur und einigen Fragen, die nur mit Quellen beantwortbar sind; plus eine Datei, die bewusst eine
   Prompt-Injection enthält und klar als Demo dafür gekennzeichnet ist. `examples/demo-knowledge-base/
   README.md` mit Beispielfragen.
4. **Seed-Skript** `pnpm demo:seed`: legt über die **öffentliche REST-API** eine Collection „RAGLab
   Demo“ an und lädt den Datensatz hoch (idempotent: vorhandene Collection wiederverwenden bzw.
   `--reset`), wartet auf Indexierung und gibt Status aus. Fehler (API/Ollama nicht erreichbar) klar melden.
5. **Video-Drehbuch** `docs/demo/video-script.md` (Deutsch; optional englische Sprechertexte):
   3–5 Minuten, Szenen mit Dauer, Bildschirmaktion, Sprechertext, Einblendungen; Ablauf: Problem →
   Start mit Docker → Collection + Upload → Indexierungsstatus → Chat mit Quellen und Zitaten →
   Playground (Scores, Prompt-Vorschau) → Prompt-Injection-Demo (ehrlich: Abgrenzung senkt Risiko,
   verhindert es nicht) → MCP (falls vorhanden) → Ausblick. Vorbereitungs-Checkliste (Modelle, Seed,
   Theme, Fenstergröße).
6. **Konsistenz-Review** aller Docs: tote Links, veraltete Statusangaben („geplant“ vs. implementiert),
   Widersprüche zwischen README, Architektur und ADRs; `docs/00-bestandsaufnahme.md` als historisches
   Dokument kennzeichnen statt umzuschreiben.
7. **CONTRIBUTING.md** aktualisieren: Setup, Befehle, Teststrategie, Eval, Konventionen (Verweis auf
   Projektregeln in `prompts/002-project-bootstrap.md` bzw. `prompts/done/`), PR-Checkliste.

## Nicht im Umfang

- Dokumentations-Website (Docusaurus o. ä.), Übersetzungen der README, Marketing-Seiten.
- Videoaufnahme selbst, Veröffentlichung, Social-Media-Posts.
- Neue Features; gefundene Bugs werden notiert oder – falls klein – mit Test behoben und dokumentiert.

## Akzeptanzkriterien

- [ ] Ein neuer Nutzer kommt allein mit der README von `git clone` bis zur ersten beantworteten Frage
      mit Quellen (selbst einmal Schritt für Schritt nachvollziehen und im Bericht bestätigen).
- [ ] README enthält nur implementierte Features als Features; Geplantes ist gekennzeichnet.
- [ ] Screenshots sind echt, aktuell, mit Alt-Text eingebunden – oder ihr Fehlen ist ehrlich vermerkt.
- [ ] `pnpm demo:seed` funktioniert gegen einen laufenden Stack und ist idempotent.
- [ ] Demo-Datensatz ist selbst verfasst, enthält Beispielfragen und eine gekennzeichnete Injection-Datei.
- [ ] Video-Drehbuch ist vollständig und passt zum tatsächlichen UI.
- [ ] Keine toten relativen Links in `README.md` und `docs/` (geprüft, z. B. per Skript).
- [ ] `pnpm format:check` grün (Markdown eingeschlossen).

## Tests

- Unit-Test für die Seed-Logik (gegen gemocktes `fetch`: Anlegen, Wiederverwenden, Fehler).
- Optional automatischer Link-Check für relative Markdown-Links (kleines Skript oder vorhandenes Tool
  mit Begründung).
- Bestehende Suite unverändert grün.

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm format:check
pnpm demo:seed   # gegen laufenden Stack mit Ollama
```

## Dokumentation & Abschluss

- `docs/architecture.md` §9 abschließend aktualisieren, `prompts/README.md` (Status aller Prompts),
  `CHANGELOG.md` (Unreleased: Docs/Demo).
- Abschlussbericht gemäß 002 mit Liste offener Punkte und Vorschlägen für die nächste Ausbaustufe
  (z. B. hybride Suche, Reranking, Chat-Persistenz, weitere Formate) als mögliche neue Prompts `017+`.
- Datei nach `prompts/done/` verschieben.
