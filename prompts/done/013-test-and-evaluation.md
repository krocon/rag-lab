# 013 – Tests & Retrieval-Evaluierung (Recall@K, MRR, reproduzierbare Läufe)

## Kontext

RAGLab ist eine self-hosted RAG-Workbench mit dem Anspruch, die RAG-Pipeline **messbar** zu machen.
Nach 003–012 existiert der vollständige MVP-Pfad inkl. Härtung. Unit- und Integrationstests sind pro
Feature entstanden; es fehlen ein kuratierter Testdatensatz, eine Retrieval-Evaluierung und ein
Überblick über Testabdeckung und -lücken.

Dieser Prompt schafft reproduzierbare Testdaten, einen Evaluierungslauf mit Recall@K, MRR und
Hit-Rate, einen Prompt-Injection-Testfall und schließt relevante Testlücken.

**Voraussetzungen:** 002–012 erledigt (mindestens 003–008).

## Zuerst untersuchen

- Bestehende Tests: `apps/api/test/**`, `apps/api/test/integration/**`, `apps/api/test/fakes/**`,
  `apps/web/**/*.spec.ts`; Vitest-Konfigurationen (`vitest.config.ts`, `vitest.integration.config.ts`).
- ADR 0002 „Konsequenzen“ (Evaluierung vor Optimierung), §2 Chunking-Garantien, §4 Retrieval.
- Retrieval-Service (007), Prompt-Builder (008), Playground (011), Security-Fixture aus 012.
- CI-Workflow `.github/workflows/ci.yml` (was läuft wo, mit welcher DB).
Erstelle zuerst eine kurze Lückenanalyse (Module × Testart) und priorisiere.

## Ziele

1. **Evaluierungsdatensatz** `eval/datasets/raglab-docs/` (Englisch, selbst geschrieben, lizenzfrei –
   keine kopierten Fremdtexte): ca. 10–20 Markdown/TXT-Dokumente mit unterscheidbaren Themen plus
   `queries.jsonl` mit 25–50 Fragen, je Frage die relevanten Dokumente/Abschnitte. Relevanz wird über
   stabile Anker referenziert (Dateiname + Überschrift oder Textmarker), **nicht** über Chunk-IDs,
   damit Chunking-Änderungen die Gold-Labels nicht brechen.
2. **Metriken** als reine, getestete Funktionen: Recall@K, Precision@K, Hit-Rate@K, MRR
   (Definitionen im Code-Kommentar und in den Docs; Relevanz auf Dokument- und optional
   Abschnittsebene).
3. **Eval-Runner** `pnpm eval` (z. B. `apps/api/src/eval/run-eval.ts` oder `tools/eval/`; Ort begründen):
   legt eine temporäre Collection an, importiert den Datensatz über die echten Services (Ingestion,
   Chunking, Embedding), führt alle Queries über den Retrieval-Service aus, berechnet Metriken für
   K ∈ {1, 3, 5, 10}, gibt eine Tabelle aus und schreibt `eval/results/<timestamp>-<model>.json`
   (git-ignoriert) mit Konfiguration (Modell, Dimension, `CHUNK_SIZE`, `CHUNK_OVERLAP`, `topK`,
   Commit-Hash) für Vergleichbarkeit. Räumt die Collection danach auf (`--keep` optional).
4. **CI-tauglicher Eval-Smoke-Test** ohne Ollama: deterministischer lexikalischer Test-Provider
   (z. B. Hashing-Bag-of-Words-Embedding im Testcode) auf einem kleinen Teil des Datensatzes mit
   Mindestwerten (Schwellwerte konservativ, begründet). Er prüft die Pipeline-Verdrahtung, **nicht**
   die Qualität eines echten Modells – das klar dokumentieren.
5. **Prompt-Injection-Testfall:** Dokument mit eingebetteten Anweisungen („Ignore all previous
   instructions…“, gefälschtes `</source>`, gefälschte Systemrolle). Automatisiert: Abgrenzung im
   Prompt und Neutralisierung (Fake-Provider). Optionaler Live-Check (`pnpm eval --injection`,
   Ollama): Antwort wird protokolliert und mit einfachen Heuristiken bewertet – nur berichtend, kein
   CI-Gate, Ergebnis ehrlich als Stichprobe darstellen.
6. **Testlücken schließen** (aus der Analyse): z. B. Ende-zu-Ende-API-Test Upload → Index → Suche →
   Chat mit Fakes in einem Integrationstest; Fehlerpfade; Abbruch.
7. **Reproduzierbarkeit:** feste Seeds, keine Zeitabhängigkeit, integrationstests isoliert
   (Tabellen leeren), Dokumentation, wie man Läufe vergleicht.

## Nicht im Umfang

- LLM-as-a-Judge für Antwortqualität, Faithfulness-/Answer-Relevance-Metriken (als Ausblick dokumentieren).
- Benchmarking-Infrastruktur, Dashboards, Speicherung von Eval-Läufen in der DB.
- Browser-E2E-Tests (Playwright o. ä.) – nur als Empfehlung mit Aufwandsschätzung, außer der Maintainer
  wünscht sie ausdrücklich.
- Optimierung von Chunking/Retrieval auf Basis der Ergebnisse (eigene Folgearbeit).

## Akzeptanzkriterien

- [ ] Datensatz und `queries.jsonl` liegen im Repo, Format ist in `eval/README.md` (Englisch) beschrieben
      und wird beim Laden validiert (zod), inkl. Fehler bei unbekannten Ankern.
- [ ] Metrikfunktionen sind mit Handbeispielen getestet (inkl. Randfälle: keine relevanten Dokumente,
      Treffer auf Rang 1, kein Treffer, Duplikate).
- [ ] `pnpm eval` läuft mit lokaler Ollama-Instanz durch und gibt Metriken + JSON-Ergebnis aus;
      ohne Ollama bricht es mit klarer Meldung ab (kein Stacktrace-Dump).
- [ ] Eval-Smoke-Test läuft in `pnpm test:integration` bzw. CI ohne externe Dienste.
- [ ] Prompt-Injection-Testfall automatisiert abgedeckt; Live-Check dokumentiert.
- [ ] Lückenanalyse + geschlossene Lücken im Bericht.
- [ ] Ein erster Referenzlauf (Modell, Parameter, Ergebnisse) ist in `docs/evaluation.md` festgehalten –
      nur mit tatsächlich gemessenen Werten; ohne Ollama-Zugang wird das offen vermerkt.

## Tests

- Unit: Metriken, Dataset-Loader/Validierung, Anker-Auflösung (Dokument/Überschrift → Chunks),
  Report-Formatierung.
- Integration: Eval-Smoke-Test mit lexikalischem Fake-Provider gegen echte DB; End-to-End-API-Test.

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build && pnpm format:check
pnpm eval              # benötigt Ollama + Modelle (nicht in CI)
```

## Dokumentation & Abschluss

- `docs/evaluation.md` (Deutsch): Metrikdefinitionen, Datensatz, Ablauf, Interpretation, Grenzen,
  Referenzlauf. `eval/README.md` (Englisch) für Contributors.
- `docs/architecture.md` §9, README (Abschnitt „Evaluation“), CONTRIBUTING (wie Tests/Eval laufen),
  `.gitignore` (`eval/results/`).
- Abschlussbericht gemäß 002; Datei nach `prompts/done/`. Nächster Prompt: `014-mcp-server.md`.
