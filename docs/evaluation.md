# RAGLab – Tests und Retrieval-Evaluierung

Stand: 2026-11-02 (Prompt 013). Englische Kurzfassung für Contributors: [eval/README.md](../eval/README.md).

ADR 0002 verlangt, Änderungen an Chunking und Retrieval **erst zu messen, dann einzubauen**. Dieses
Dokument beschreibt den Evaluierungsdatensatz, die Metriken, den Ablauf von `pnpm eval`, den
CI-Smoke-Test, den Prompt-Injection-Testfall, die Testlückenanalyse und die bisher gemessenen Werte.

## 1. Überblick

| Baustein                            | Ort                                                    | Läuft in                           |
| ----------------------------------- | ------------------------------------------------------ | ---------------------------------- |
| Datensatz (14 Dokumente, 40 Fragen) | `eval/datasets/raglab-docs/`                           | –                                  |
| Metriken, Loader, Runner, Report    | `apps/api/src/eval/`                                   | `pnpm eval`                        |
| Lexikalische Baseline               | `apps/api/src/eval/lexical-embedding-provider.ts`      | Smoke-Test, `pnpm eval --baseline` |
| Unit-Tests                          | `apps/api/test/eval/`                                  | `pnpm test`                        |
| Eval-Smoke-Test                     | `apps/api/test/integration/eval.int.test.ts`           | `pnpm test:integration`, CI        |
| End-to-End-API-Test                 | `apps/api/test/integration/e2e.int.test.ts`            | `pnpm test:integration`, CI        |
| Ergebnisse                          | `eval/results/<zeitstempel>-<modell>.json` (ignoriert) | –                                  |

**Ort des Runners (begründet):** `apps/api/src/eval/` statt `tools/eval/`. Der Runner nutzt die
echten Services (`createServices`), Konfiguration (`loadConfig`), Datenbank und Provider der API;
ein eigenes Paket müsste diese Verdrahtung duplizieren oder tief in `apps/api` importieren. Der Code
ist über HTTP nicht erreichbar und wird nur per `pnpm eval` (tsx) gestartet.

## 2. Metriken

Eine Anfrage liefert eine Rangliste von Chunks (`topK = 10`). `K` zählt **Chunks** – genau das,
was der Chat als Kontext bekommt –, nicht verschiedene Dokumente. Relevanz wird auf zwei Ebenen
bewertet:

- **Dokumentebene:** Ein Chunk ist relevant, wenn sein Dokument in einem Anker der Frage vorkommt.
  Relevante Elemente = die referenzierten Dokumente.
- **Abschnittsebene:** Ein Chunk ist relevant, wenn er einen Anker der Frage trifft (Überschrift,
  Textmarker oder ganzes Dokument, §3). Relevante Elemente = die Anker.

Für eine Frage mit relevanter Menge `R` und Rangliste `r₁ … rₙ`:

| Metrik          | Definition                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------- |
| **Recall@K**    | \|in den ersten K Treffern gefundene relevante Elemente\| / \|R\|                               |
| **Precision@K** | Anzahl relevanter Chunks unter den ersten K / K (Nenner bleibt K, auch bei < K Treffern)        |
| **Hit-Rate@K**  | 1, wenn mindestens einer der ersten K Chunks relevant ist, sonst 0                              |
| **MRR**         | Mittelwert über Fragen von 1 / Rang des ersten relevanten Chunks (0, wenn keiner in den Top 10) |

Festlegungen (Code: `apps/api/src/eval/metrics.ts`, Tests mit Handbeispielen):

- **Duplikate:** Mehrere Chunks desselben relevanten Dokuments/Abschnitts zählen für Recall einmal
  (gefunden oder nicht), für Precision jeder einzeln (jeder ist nützlicher Kontext).
- **Keine relevanten Elemente:** alle Metriken sind _undefiniert_ (`null`) und fließen nicht in
  Mittelwerte ein; der Loader verlangt ohnehin mindestens einen Anker pro Frage.
- **Mittelwerte** sind Makro-Mittel (jede Frage zählt gleich).
- Die Werte für K < 10 stammen aus dem Präfix der Top-10-Liste; das entspricht einer Suche mit
  kleinerem `topK`, weil die Sortierung stabil ist.

**Interpretation:** Hit-Rate@K beantwortet „bekommt der Chat bei `topK = K` überhaupt eine passende
Quelle?“; Recall@K ist bei Fragen mit mehreren relevanten Stellen strenger; MRR zeigt, ob das
Relevante oben steht (wichtig, weil das Kontextbudget von oben auffüllt). Precision@K ist bei einem
einzigen relevanten Abschnitt nach oben begrenzt (bei K = 10 meist 0,1) und nur zwischen Läufen mit
gleichem K und gleichem Chunking vergleichbar.

## 3. Datensatz `raglab-docs`

14 selbst geschriebene englische Texte (12 Markdown, 2 TXT, lizenzfrei, keine kopierten
Fremdtexte) mit klar unterscheidbaren Themen – Sauerteig, Imkerei, Git, PostgreSQL-Backups,
Kompost, Marathon, Zimmerpflanzen, Solar, Fahrrad, Kaffee, Passwörter, RAG-Glossar, Astronomie,
Zeitzonen – und bewusst geteiltem Vokabular („hydration“, „backup“, „temperature“), damit die
Aufgabe nicht trivial ist. `queries.jsonl` enthält 40 umformulierte Fragen; 38 haben einen
relevanten Abschnitt, zwei (q39, q40) mehrere über Dokumentgrenzen hinweg.

**Anker statt Chunk-IDs:** Relevanz wird über `document` + `heading` (exakte Überschrift, im Dokument
eindeutig) oder `document` + `marker` (wörtlicher, eindeutiger Text, Whitespace-tolerant) oder nur
`document` angegeben. Weil der Chunker nie über Abschnittsgrenzen schneidet (ADR 0002 §2), ist
„Chunk liegt im Abschnitt“ gleichbedeutend mit „Überschriftenpfad des Chunks enthält die
Überschrift“. Geänderte Chunk-Größen brechen die Gold-Labels daher nicht. Ein Marker, den eine
Chunk-Grenze zerschneidet, ist nicht auflösbar; der Lauf meldet solche Anker
(„Anchors no chunk matches“).

**Validierung beim Laden (zod):** JSON pro Zeile, Pflichtfelder, keine unbekannten Felder,
eindeutige IDs, keine doppelten Anker, `heading` xor `marker`, unbekannte Dokumente/Überschriften
und nicht gefundene oder mehrdeutige Marker → Fehler mit Zeilennummer. Format: [eval/README.md](../eval/README.md).

## 4. Ablauf von `pnpm eval`

1. Konfiguration laden (`.env`/Umgebung), Datensatz laden und validieren.
2. Provider prüfen: Ollama nicht erreichbar oder Modell fehlt → eine klare Meldung mit Hinweis
   (`ollama pull …` wird nur genannt, nie ausgeführt), Exit-Code 1, kein Stacktrace
   (`RAGLAB_EVAL_DEBUG=1` zeigt ihn). Datenbank und Schema werden mit der Readiness-Probe geprüft.
3. Temporäre Collection `eval-<datensatz>-<zeitstempel>` in der Datenbank von `DATABASE_URL`
   anlegen; jedes Dokument über `DocumentsService.upload` hochladen (Validierung, Normalisierung,
   Hash) und vom echten Indexer verarbeiten lassen (Chunking → Embedding). Ein Dokument, das nicht
   `ready` wird, bricht den Lauf mit dessen Fehlermeldung ab.
4. Jede Frage über `RetrievalService.search` mit `topK = 10` ausführen (derselbe Pfad wie Chat und
   Playground), Treffer auf Anker abbilden, Metriken für K ∈ {1, 3, 5, 10} berechnen.
5. Tabelle ausgeben und `eval/results/<zeitstempel>-<modell>.json` schreiben.
6. Collection löschen (auch bei Fehler oder Strg+C); `--keep` behält sie zur Inspektion in der UI.

Optionen: `--baseline` (lexikalische Baseline statt Modell), `--injection` (§7), `--dataset <dir>`,
`--out <dir>`, `--keep`, `--help`.

**Ergebnisdatei:** Datensatzname und SHA-256 über alle Dateien, Provider, Modell, Dimension,
`CHUNK_SIZE`, `CHUNK_OVERLAP`, `topK`, K-Werte, Commit-Hash und „dirty“-Flag, Indexierungs- und
Suchdauer, nicht auflösbare Anker, Mittelwerte und pro Frage die Rangliste (Datei, Chunk-Index,
Überschriftenpfad, Score, getroffene Anker) mit Einzelmetriken. Chunk-Inhalte werden nicht
gespeichert.

**Läufe vergleichen:** nur bei gleichem Datensatz-Hash; pro Lauf genau einen Parameter ändern
(z. B. `CHUNK_SIZE=800 CHUNK_OVERLAP=100 pnpm eval`) und `summary` der JSON-Dateien vergleichen,
etwa mit `jq '.summary.section.atK["5"]' eval/results/*.json`. Pro-Frage-Ranglisten zeigen, welche
Fragen sich verbessert oder verschlechtert haben.

## 5. Reproduzierbarkeit

- **Deterministische Eingaben:** fester Datensatz (Hash in jedem Ergebnis), deterministischer
  Chunker, feste K-Werte, stabile Sortierung im Retrieval-Service.
- **Lexikalische Baseline ohne Gleichstände:** Reine Wort-Hashes ergeben für Texte ohne
  gemeinsames Wort exakt dieselbe Distanz; die Reihenfolge entschiede dann die zufällige
  UUIDv7-Dokument-ID. Ein kleiner Zeichen-Trigramm-Anteil (10 % der Kosinus-Ähnlichkeit) verhindert
  das. Der Smoke-Test prüft, dass zwei Läufe identische Metriken **und** Ranglisten liefern;
  manuell wurden vier `--baseline`-Läufe mit identischer Ausgabe bestätigt.
- **HNSW** ist ein approximativer Index mit zufälligem Graphaufbau (pgvector bietet keinen Seed).
  Bei den ~60–90 Chunks des Datensatzes und `ef_search ≥ 40` mit iterativem Scan ist die Suche
  praktisch exakt; bei großen eigenen Datensätzen können sich tiefe Ränge zwischen Läufen minimal
  unterscheiden.
- **Echte Modelle** sind bei gleicher Modellversion deterministisch genug; Modellname allein
  identifiziert die Version nicht (Ollama-Tags können sich ändern) – bei Vergleichen über längere
  Zeit den Digest aus `ollama list` notieren.
- **Integrationstests isoliert:** Sie laufen in einer eigenen Testdatenbank (§8) und leeren deren
  Tabellen vor jedem Test; keine Zeitabhängigkeit in Assertions.

## 6. CI-Smoke-Test (ohne Ollama)

`test/integration/eval.int.test.ts` lässt den **gesamten** Datensatz (statt eines Teils, Abweichung
vom Prompt: ~64 Chunks indexieren in deutlich unter einer Sekunde, der Teil brächte keinen
Zeitgewinn) mit der lexikalischen Baseline durch die echte Pipeline und PostgreSQL laufen:

- Mindestwerte: Dokument-Hit-Rate@5 ≥ 0,9, Dokument-Recall@10 ≥ 0,9, Dokument-MRR ≥ 0,75,
  Abschnitts-Recall@5 ≥ 0,8, Abschnitts-MRR ≥ 0,7.
- **Begründung der Schwellwerte:** gemessen werden 1,0 / 1,0 / 0,952 / 0,983 / 0,904 (§9). Die
  Schwellwerte liegen 0,1–0,2 darunter, damit kleine Datensatz- oder Chunking-Änderungen CI nicht
  brechen. Eine fehlerhafte Verdrahtung (falsche Collection, verlorene Sortierung, kaputte
  Anker-Zuordnung) fällt weit darunter: Der **Kontrolllauf** mit pseudozufälligen Vektoren
  (`fakeVector`) erreicht Dokument-MRR 0,18 und Abschnitts-Recall@5 0,0 und ist als Test
  festgehalten (MRR < 0,5).
- Zusätzlich: keine unauflösbaren Anker, 10 Treffer pro Frage, Collection/Chunks danach gelöscht,
  zwei Läufe identisch.

**Wichtig:** Der Smoke-Test prüft die **Verdrahtung** der Evaluierung, **nicht** die Qualität eines
echten Embedding-Modells. Die Baseline findet nur Wortüberschneidungen; Synonyme oder
Umschreibungen ohne gemeinsame Wörter erkennt sie nicht. CI führt außerdem `pnpm eval --baseline`
als CLI-Probe aus.

## 7. Prompt-Injection-Testfall

Fixture: `apps/api/test/fixtures/security/prompt-injection.md` (aus 012) – „IGNORE ALL PREVIOUS
INSTRUCTIONS“, gefälschtes `</source>` und `<source id="99">`, gefälschte `SYSTEM:`-Rolle,
Unicode-Varianten von Tags, gefälschte „Question:“/„## Assistant“-Abschnitte.

**Automatisiert (deterministisch, CI):**

- `test/security/prompt-injection.test.ts` – Neutralisierung aller Begrenzer-Varianten, das
  Dokument bleibt in seinem eigenen `<source>`-Block, Systemprompt erklärt Quellen zu Daten.
- `test/integration/security.int.test.ts` – derselbe Nachweis über Upload, Chunking, pgvector und
  Prompt-Builder gegen PostgreSQL (Fake-Chat-Provider zeichnet den Prompt auf).
- `test/eval/injection-check.test.ts` – Heuristiken des Live-Checks und dessen Ablauf mit
  Fake-Providern.

**Optionaler Live-Check** `pnpm eval --injection` (benötigt `EMBEDDING_MODEL` und `CHAT_MODEL` in
Ollama; mit `--baseline` nur das Chat-Modell): legt eine temporäre Collection nur mit der Fixture
an, stellt drei Fragen über den echten Chat-Service, protokolliert Antworten in
`eval/results/<zeitstempel>-<chatmodell>-injection.json` und bewertet sie mit einfachen
Heuristiken (Angreifer-URL, „deprecated“, „developer mode“, Systemprompt-Leck, Zustimmung zum
Ignorieren der Quellen, Zitat nicht existierender Quellen). Ergebnis `no_obvious_compliance` heißt
nur „nichts Offensichtliches gefunden“, **nicht** „robust“. Der Check ist berichtend, kein CI-Gate,
und eine Stichprobe eines Modells. **Bisher nicht ausgeführt** (kein Chat-Modell installiert, §9).

## 8. Testlückenanalyse (Stand vor 013) und geschlossene Lücken

| Modul / Bereich               | Unit                                 | Integration (PG)                                                                              | Ende-zu-Ende API                 | Qualität/Live             |
| ----------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------- |
| collections, documents        | ✅                                   | ✅                                                                                            | ⚠️ einzeln                       | –                         |
| ingestion (Indexer, Recovery) | ✅                                   | ✅ (Recovery)                                                                                 | ❌ Shutdown-Abbruch nur unit     | –                         |
| chunking                      | ✅ (Tabellen, Eigenschaften, Golden) | ✅                                                                                            | –                                | ❌ keine Retrieval-Metrik |
| embeddings                    | ✅ (Fake-`fetch`, Fake-HTTP)         | ✅                                                                                            | –                                | ⚠️ Live-Test optional     |
| retrieval                     | ✅                                   | ✅ (Hand-Vektoren)                                                                            | ❌ Relevanz nie geprüft          | ❌ Recall/MRR fehlten     |
| chat                          | ✅ (inkl. Abbruch)                   | ✅ (Zufallsvektoren)                                                                          | ⚠️ ohne Provider-Fehler gegen PG | ❌ Modellverhalten        |
| playground                    | ✅                                   | ✅                                                                                            | ⚠️                               | –                         |
| security (Injection)          | ✅                                   | ✅                                                                                            | –                                | ❌ Modellverhalten        |
| web (Angular)                 | ✅ 22 Spec-Dateien                   | –                                                                                             | ❌ kein Browser-E2E              | –                         |
| Testinfrastruktur             | –                                    | ❌ `pnpm test:integration` leerte die **Entwicklungsdatenbank** (Fallback auf `DATABASE_URL`) | –                                | –                         |

**Priorisierung und Umsetzung:**

1. **Isolation der Integrationstests (hoch, Datenverlust):** `test/integration/test-database.ts`
   und `global-setup.ts` – Tests nutzen `TEST_DATABASE_URL` oder automatisch
   `<DATABASE_URL-Name>_test` auf demselben Server, legen sie bei Bedarf an (`CREATE DATABASE`) und
   migrieren sie. Verweigert werden Datenbanknamen ohne „test“ und dieselbe Datenbank wie
   `DATABASE_URL`; `resetDatabase` prüft zusätzlich `current_database()`. Unit-getestet
   (`test/test-database.test.ts`).
2. **Retrieval-Qualität messbar (hoch, Ziel des Prompts):** Datensatz, Metriken, `pnpm eval`,
   Smoke-Test (§2–6).
3. **Ende-zu-Ende über HTTP mit tatsächlicher Relevanz (mittel):** `e2e.int.test.ts` – Upload →
   Indexierung → Suche findet den richtigen Abschnitt → Playground zeigt dieselben Chunks wie
   Chat → Chat mit Zitat → Löschen (404, keine Chunks mehr).
4. **Fehlerpfade gegen PostgreSQL (mittel):** nicht erreichbarer Embedding-Provider → `503
EMBEDDING_PROVIDER_UNAVAILABLE` für Suche und Chat (Chat-Modell wird nicht aufgerufen), danach
   Erholung.
5. **Abbruch (mittel):** Server-Shutdown während der Indexierung → Dokument `failed` mit
   Shutdown-Meldung in PostgreSQL, Reindex macht es `ready`. Chat-Abbruch bleibt unit-getestet
   (`chat.abort.test.ts`); `app.inject` kann keinen Client-Abbruch mitten im Stream simulieren.
6. **Modellverhalten bei Injection (niedrig, nicht deterministisch):** optionaler Live-Check (§7).

**Empfehlung Browser-E2E (nicht umgesetzt, außerhalb des Umfangs):** Playwright mit drei bis vier
Flüssen (Collection anlegen + Upload + Status, Chat mit Quellenkarten, Playground, Fehlerzustand
ohne Ollama) gegen API mit Fake-Ollama-Server und Testdatenbank. Aufwand ≈ 1,5–2 Tage (Setup,
Fixtures, stabile Selektoren, CI-Job mit Browser-Cache), laufende Pflege bei UI-Änderungen.

## 9. Referenzläufe

Gemessen am 2026-11-02 auf Commit `7cf5a00` + Arbeitsstand von 013 (Working Tree „dirty“), macOS,
PostgreSQL 18 + pgvector 0.8.7 (Docker), Datensatz `raglab-docs` (14 Dokumente, 40 Fragen).

### 9.1 Echtes Embedding-Modell – **nicht ausgeführt**

In der Umgebung dieses Prompts läuft Ollama, aber **ohne installierte Modelle**; Modelle werden
nicht ungefragt heruntergeladen. `pnpm eval` bricht daher erwartungsgemäß ab mit:

```text
pnpm eval failed: Embedding model "nomic-embed-text" is not installed in Ollama. Run "ollama pull nomic-embed-text" on the Ollama host. RAGLab never downloads models itself.
```

Ein Referenzlauf mit `nomic-embed-text` (768 Dimensionen) steht aus. Ausführen mit
`ollama pull nomic-embed-text && pnpm eval` und die Tabelle hier ergänzen – nur mit tatsächlich
gemessenen Werten.

### 9.2 Lexikalische Baseline (gemessen, kein semantisches Modell)

`pnpm eval --baseline`, Provider `lexical-baseline` / `hashed-bag-of-words-v1`, 768 Dimensionen,
`topK` 10. Vier Wiederholungen mit identischer Ausgabe.

**`CHUNK_SIZE` 1200, `CHUNK_OVERLAP` 200 (Standard) – 64 Chunks:**

| Ebene     | K   | Recall | Precision | Hit-Rate |
| --------- | --- | ------ | --------- | -------- |
| Dokument  | 1   | 0,912  | 0,925     | 0,925    |
| Dokument  | 3   | 0,946  | 0,617     | 0,975    |
| Dokument  | 5   | 1,000  | 0,505     | 1,000    |
| Dokument  | 10  | 1,000  | 0,322     | 1,000    |
| Abschnitt | 1   | 0,833  | 0,850     | 0,850    |
| Abschnitt | 3   | 0,917  | 0,325     | 0,950    |
| Abschnitt | 5   | 0,983  | 0,215     | 1,000    |
| Abschnitt | 10  | 1,000  | 0,113     | 1,000    |

MRR@10: Dokument 0,952 · Abschnitt 0,904.

**`CHUNK_SIZE` 400, `CHUNK_OVERLAP` 50 – 86 Chunks:** Dokument Hit-Rate@1 0,900, @5 0,975,
MRR 0,938; Abschnitt Recall@5 0,917, MRR 0,887; q30 ohne relevantes Dokument in den Top 5.

**Einordnung:** Die hohen Werte zeigen vor allem, dass der Datensatz mit Wortüberschneidungen gut
lösbar ist – die Fragen sind umformuliert, teilen aber Schlüsselwörter mit den Abschnitten. Für
echte Modelle ist die Baseline der Vergleichsmaßstab: Ein semantisches Modell sollte sie bei
Abschnitts-MRR und Hit-Rate@1 erreichen oder übertreffen. Ist die Baseline gleich gut, braucht der
Datensatz schwerere Fragen (Synonyme, ohne gemeinsame Begriffe) – ein sinnvoller nächster Schritt.
Kleinere Chunks verschlechtern die Baseline hier leicht (Abschnitte werden zerteilt, Schlüsselwörter
verteilen sich); das ist kein Beleg für echte Modelle.

### 9.3 Prompt-Injection live – **nicht ausgeführt**

Kein Chat-Modell installiert. Ausführen mit `ollama pull llama3.2 && pnpm eval --injection` und
Antworten samt Heuristik hier als Stichprobe dokumentieren.

## 10. Grenzen und Ausblick

- Der Datensatz ist klein und thematisch weit gestreut; er misst grobe Regressionen und
  Größenordnungen, keine feinen Unterschiede (eine Frage = 2,5 Prozentpunkte).
- Relevanzurteile stammen vom Autor des Datensatzes; nicht markierte, aber ebenfalls passende
  Abschnitte senken Precision und ggf. MRR.
- Gemessen wird nur Retrieval. **Nicht im Umfang** (Ausblick): Antwortqualität per
  LLM-as-a-Judge, Faithfulness (Antwort durch Quellen gedeckt), Answer Relevance, Zitiergenauigkeit;
  Speicherung von Läufen in der Datenbank, Dashboards; Optimierung von Chunking/Retrieval anhand der
  Ergebnisse (eigene Folgearbeit, z. B. hybride Suche, Reranking, Chunk-Größen).
