# RAGLab – Video-Drehbuch (Demo, ca. 4:30 Minuten)

Ziel: RAGLab in einem kurzen Screencast ehrlich vorstellen – was es ist (eine nachvollziehbare
RAG-Workbench, **kein ChatGPT-Klon**), wie man es startet und wie man Antworten bis zur Quelle
zurückverfolgt. Sprechertexte auf Deutsch; englische Fassung jeweils darunter (optional, für eine
englische Tonspur oder Untertitel).

Alles im Video existiert in v0.1.0. Nicht zeigen oder versprechen: Authentifizierung,
Chat-Verlauf, PDF-Import, hybride Suche/Reranking, andere Provider als Ollama – das ist nicht
implementiert (README → „Not implemented“).

## Vorbereitung (Checkliste)

- [ ] **Modelle installiert** (nicht im Video zeigen, wie lange der Download dauert):
      `ollama pull nomic-embed-text` und ein Chat-Modell, z. B. `ollama pull llama3.2`;
      `ollama list` zeigt beide. Ein Modell nehmen, dessen Antworten man vorher geprüft hat.
- [ ] **Modelle vorgewärmt:** einmal `curl -s 'localhost:3000/api/system/providers?verify=true'`
      und eine Testfrage im Chat, damit im Video kein Modell-Ladevorgang (erste Anfrage) auftritt.
- [ ] **Saubere Datenbank:** keine privaten Collections sichtbar. Ggf. eigene Datenbank
      (siehe [screenshots.md](screenshots.md), Schritt 1) oder `pnpm demo:seed --reset`.
- [ ] **Stack:** `docker compose --profile app up -d --build` vorab einmal gebaut (im Video nur
      der Start), `docker compose ps` zeigt alles `healthy`.
- [ ] **Demo-Daten:** Für Szene 3 die Collection _RAGLab Demo_ **nicht** vorab anlegen
      (Upload wird gezeigt). Für den Fall, dass der Upload live hakt: zweite Aufnahme mit
      `pnpm demo:seed` als Plan B.
- [ ] Ordner `examples/demo-knowledge-base/` im Finder/Dateimanager geöffnet (Drag & Drop).
- [ ] **Fragen vorher ausprobiert** (Liste in
      [examples/demo-knowledge-base/README.md](../../examples/demo-knowledge-base/README.md)) und
      die Antworten gegen die Quellen geprüft – im Video nur Antworten zeigen, die stimmen, und
      Fehler nicht wegschneiden, sondern benennen.
- [ ] **Theme:** Settings → Theme → _Light_ für die Hauptaufnahme (bessere Lesbarkeit im Video);
      Dark Mode nur kurz in Szene 9.
- [ ] **Fenster:** Browser 1440 × 900 (oder 1280 × 800), Zoom 110–125 %, Lesezeichenleiste und
      Erweiterungen ausgeblendet, Benachrichtigungen aus.
- [ ] Terminal: große Schrift (≥ 18 pt), heller oder dunkler Hintergrund passend zum Theme, Prompt
      ohne private Pfade.
- [ ] MCP (Szene 8): `pnpm build:mcp`, Server im MCP-Client registriert (README → „MCP server“),
      Tool-Bestätigungen im Client **eingeschaltet** lassen.

## Szenen

| #   | Zeit      | Dauer | Inhalt                           |
| --- | --------- | ----- | -------------------------------- |
| 1   | 0:00–0:20 | 20 s  | Das Problem                      |
| 2   | 0:20–0:45 | 25 s  | Start mit Docker                 |
| 3   | 0:45–1:20 | 35 s  | Collection anlegen und hochladen |
| 4   | 1:20–1:45 | 25 s  | Indexierungsstatus und Chunks    |
| 5   | 1:45–2:30 | 45 s  | Chat mit Quellen und Zitaten     |
| 6   | 2:30–3:15 | 45 s  | Retrieval Playground             |
| 7   | 3:15–3:50 | 35 s  | Prompt-Injection-Demo            |
| 8   | 3:50–4:15 | 25 s  | MCP-Server                       |
| 9   | 4:15–4:35 | 20 s  | Ausblick                         |

Jede Szene: **Bild** (Bildschirmaktion), **Sprecher** (Text), **Einblendung** (Overlay).

### Szene 1 – Das Problem (0:00–0:20)

- **Bild:** Chat-Seite mit einer bereits gestellten Frage, Antwort mit Zitaten **[1]**, **[2]**;
  langsamer Zoom auf die Quellenkarten.
- **Sprecher (DE):** „Ein RAG-System antwortet aus deinen Dokumenten. Aber warum genau diese
  Antwort? Welche Passagen wurden gefunden, wie ähnlich waren sie, was ging ans Modell? RAGLab ist
  eine Open-Source-Werkbank, die genau das sichtbar macht.“
- **Speaker (EN):** "A RAG system answers from your documents. But why this answer? Which passages
  were found, how similar were they, what was sent to the model? RAGLab is an open-source workbench
  that makes exactly this visible."
- **Einblendung:** „RAGLab – an open-source RAG workbench for developers“ · „not a ChatGPT clone“

### Szene 2 – Start mit Docker (0:20–0:45)

- **Bild:** Terminal: `docker compose --profile app up -d` (Images vorab gebaut), danach
  `docker compose ps` mit `healthy`; Browser öffnet `http://localhost:8080`, Welcome-Seite mit
  System-Status _API Running_, _Database Up_, _pgvector Up_.
- **Sprecher (DE):** „RAGLab läuft lokal: PostgreSQL mit pgvector, eine Fastify-API und eine
  Angular-Oberfläche – ein Befehl mit Docker Compose. Die Modelle kommen aus Ollama auf deinem
  Rechner; RAGLab lädt nie selbst Modelle herunter.“
- **Speaker (EN):** "RAGLab runs locally: PostgreSQL with pgvector, a Fastify API and an Angular UI –
  one Docker Compose command. Models come from Ollama on your machine; RAGLab never downloads models
  by itself."
- **Einblendung:** `docker compose --profile app up -d` · „Ports nur auf 127.0.0.1“

### Szene 3 – Collection anlegen und hochladen (0:45–1:20)

- **Bild:** **Knowledge Bases** → **New knowledge base** → Name „RAGLab Demo“, Beschreibung
  „Docs of a fictional job scheduler“ → **Create knowledge base**. Auf der Detailseite alle Dateien
  aus `examples/demo-knowledge-base/` (ohne `README.md`) auf „Drag files here or“ ziehen;
  Fortschritt pro Datei.
- **Sprecher (DE):** „Eine Knowledge Base ist eine Sammlung von Markdown- und Textdateien. Als
  Beispiel nehme ich die Dokumentation von ‚Kettlebird‘ – einem erfundenen Job-Scheduler. Erfunden,
  damit das Modell die Antworten nicht schon kennt: Es muss sie in den Quellen finden.“
- **Speaker (EN):** "A knowledge base is a collection of Markdown and text files. As an example I use
  the documentation of 'Kettlebird' – a made-up job scheduler. Made up, so the model can't know the
  answers already: it has to find them in the sources."
- **Einblendung:** „Alternative: `pnpm demo:seed` lädt denselben Datensatz über die REST-API“

### Szene 4 – Indexierungsstatus (1:20–1:45)

- **Bild:** Dokumenttabelle: Status wechselt von _Pending_/_Processing_ zu _Ready_, Spalte
  _Chunks_ füllt sich. Ein Dokument öffnen (`retries-and-failures.md`) → **Chunks** mit Offsets,
  Überschriftenpfad und _Embedding stored_.
- **Sprecher (DE):** „Jede Datei wird normalisiert, an Überschriften und Absätzen in Chunks
  zerlegt und eingebettet. Fertig heißt hier: gechunkt und mit Vektor gespeichert. Jeder Chunk
  ist einsehbar – mit Position im Text und Überschriftenpfad.“
- **Speaker (EN):** "Each file is normalised, split into chunks at headings and paragraphs, and
  embedded. 'Ready' means chunked and stored with a vector. Every chunk can be inspected – with its
  position in the text and its heading path."
- **Einblendung:** „Upload → Normalize → Chunk → Embed → pgvector“

### Szene 5 – Chat mit Quellen und Zitaten (1:45–2:30)

- **Bild:** **Chat**, Knowledge Base _RAGLab Demo_, Frage „How long does Kettlebird wait before
  the second retry?“ → **Enter**. Erst erscheinen die Quellen, dann streamt die Antwort. Auf
  **[1]** klicken → Quellenkarte _Selected_, Abschnitt „Retry policy“, `score`; **Open in
  document** springt zum markierten Chunk. Dann die Frage „What is the capital of France?“ –
  die Antwort sagt, dass die Quellen das nicht enthalten (vorher prüfen; falls das Modell es
  nicht tut, ehrlich so kommentieren).
- **Sprecher (DE):** „Die Frage wird eingebettet, die ähnlichsten Chunks gehen als nummerierte
  Quellen an das Chat-Modell. Die Antwort zitiert sie – und jedes Zitat führt zur exakten Passage.
  Zitate auf Quellen, die das Modell gar nicht bekommen hat, markiert RAGLab als unbekannt.“
- **Speaker (EN):** "The question is embedded, and the most similar chunks go to the chat model as
  numbered sources. The answer cites them – and every citation leads to the exact passage. Citations
  of sources the model never received are flagged as unknown."
- **Einblendung:** „score = Ähnlichkeit, keine Konfidenz“

### Szene 6 – Retrieval Playground (2:30–3:15)

- **Bild:** **Retrieval Playground**, Knowledge Base _RAGLab Demo_, dieselbe Frage, Top-K 5 →
  **Search**. Tabelle mit Rank, Score-Balken, Distance, Quelle, _In chat
  context_. Eine Zeile mit **Show** aufklappen. **minScore** auf einen Wert setzen, der die
  letzten Treffer als _Below minScore_ markiert. **Show prompt** anhaken → **Prompt preview** mit
  Systemprompt und `<source>`-Blöcken. Kurz zu **Diagnostics** scrollen. URL kopieren;
  **Ask in chat** führt mit derselben Frage zurück in den Chat.
- **Sprecher (DE):** „Der Playground zeigt, was der Chat finden würde – ohne das Sprachmodell zu
  fragen. Score ist eins minus Kosinus-Distanz: höher heißt ähnlicher, aber es ist keine
  Wahrscheinlichkeit, und Werte verschiedener Modelle sind nicht vergleichbar. Hier sehe ich,
  welche Chunks ins Kontextbudget passen, und den exakten Prompt. Die Suche steht in der URL –
  teilbar und reproduzierbar.“
- **Speaker (EN):** "The playground shows what the chat would retrieve – without asking the language
  model. Score is one minus cosine distance: higher means more similar, but it's not a probability,
  and scores of different models aren't comparable. I can see which chunks fit into the context
  budget, and the exact prompt. The search lives in the URL – shareable and reproducible."
- **Einblendung:** „distance (pgvector `<=>`, 0..2, niedriger = ähnlicher) · score = 1 − distance“

### Szene 7 – Prompt-Injection-Demo (3:15–3:50)

- **Bild:** `prompt-injection-demo.md` im Dokument-View öffnen, den Hinweis oben und den
  Abschnitt „Planned maintenance“ mit der eingeschleusten Anweisung zeigen. Im Playground mit
  **Show prompt** die Frage „Is there a maintenance window for Kettlebird?“ → die Anweisung steht
  **innerhalb** eines `<source>`-Blocks, der Systemprompt sagt, Anweisungen in Quellen zu
  ignorieren. Dann dieselbe Frage im Chat. Das Ergebnis zeigen, **wie es ist** – ob das Modell
  die Anweisung ignoriert oder ihr folgt.
- **Sprecher (DE):** „Dokumente sind nicht vertrauenswürdig. Diese Datei enthält absichtlich eine
  Prompt-Injection. RAGLab trennt Dokumenttext klar von Anweisungen, neutralisiert gefälschte
  Begrenzer und gibt dem Modell keine Werkzeuge. Das senkt das Risiko – verhindert es aber nicht.
  Deshalb sind die Quellen immer sichtbar: Prüfe jede Antwort gegen sie.“
- **Speaker (EN):** "Documents are untrusted. This file deliberately contains a prompt injection.
  RAGLab separates document text from instructions, neutralises fake delimiters and gives the model
  no tools. That lowers the risk – it doesn't prevent it. That's why sources are always visible:
  check every answer against them."
- **Einblendung:** „Abgrenzung senkt das Risiko – sie verhindert es nicht.“

### Szene 8 – MCP-Server (3:50–4:15)

- **Bild:** MCP-Client (z. B. Claude Code oder Claude Desktop) mit registriertem Server
  `raglab`: Aufforderung „Search the RAGLab Demo knowledge base for how parked jobs are resumed“.
  Der Client zeigt den Aufruf von `search_knowledge` (Bestätigungsdialog sichtbar lassen), das
  Ergebnis mit Score und Datei, danach die Antwort des Clients.
- **Sprecher (DE):** „Über einen lokalen MCP-Server können auch andere KI-Clients deine Knowledge
  Bases nutzen – nur lesend: Collections auflisten, suchen, Dokumente lesen und fragen.
  Dokumentinhalte kommen als ‚untrusted‘ markiert zurück.“
- **Speaker (EN):** "Through a local MCP server, other AI clients can use your knowledge bases too –
  read-only: list collections, search, read documents and ask. Document content comes back marked
  as untrusted."
- **Einblendung:** „`list_collections` · `search_knowledge` · `get_document` · `ask_knowledge`“

### Szene 9 – Ausblick (4:15–4:35)

- **Bild:** Settings → Theme → _Dark_, kurzer Schwenk über Playground im Dark Mode; dann
  README auf GitHub (`https://github.com/krocon/rag-lab`) mit dem Abschnitt „Not implemented“.
- **Sprecher (DE):** „RAGLab ist Open Source unter MIT. Als Nächstes stehen hybride Suche,
  Reranking, Chat-Verlauf und weitere Formate an. Wichtig: RAGLab hat keine Anmeldung – betreibe
  es lokal oder nur hinter einem Reverse Proxy mit Authentifizierung. Probier es mit dem
  Demo-Datensatz aus.“
- **Speaker (EN):** "RAGLab is open source under the MIT license. Next up are hybrid search,
  reranking, chat history and more formats. Important: RAGLab has no login – run it locally or only
  behind a reverse proxy with authentication. Try it with the demo dataset."
- **Einblendung:** `github.com/krocon/rag-lab` · „MIT“ · „no auth – keep it local“

## Hinweise für Aufnahme und Schnitt

- Echte Ausgaben verwenden; Antworten nicht nachträglich schönen oder austauschen. Wenn ein Modell
  falsch zitiert oder der Injection folgt, ist das Teil der Botschaft (Szene 7).
- Keine erfundenen Zahlen einblenden (Geschwindigkeit, Qualität). Eval-Ergebnisse nur nennen,
  wenn sie mit dem gezeigten Modell tatsächlich gemessen wurden (`pnpm eval`).
- Wartezeiten (Indexierung, erste Modellanfrage) dürfen gekürzt werden, aber mit sichtbarem
  Schnitt bzw. Einblendung „gekürzt“.
- Die Screenshots in `docs/images/` stammen von Test-Providern ([screenshots.md](screenshots.md))
  und eignen sich nicht als Standbilder für Modell-Ergebnisse.
