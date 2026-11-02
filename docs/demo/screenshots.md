# Screenshots – Herkunft und Neuerstellung

Die Bilder in [`docs/images/`](../images/) sind **echte Screenshots der laufenden Web-App**
(Prompt 016, 2026-11-02), keine Mockups. Sie zeigen den
[Demo-Datensatz](../../examples/demo-knowledge-base/README.md), geladen mit `pnpm demo:seed`.

## Wichtig: aufgenommen mit Test-Providern

In der Entwicklungsumgebung war **kein Ollama-Modell installiert** (Modelle werden nie ungefragt
geladen). Die Screenshots entstanden deshalb mit einem lokalen Fake-Ollama-Server:

| Rolle     | Im UI sichtbarer Name    | Tatsächlich                                                                                                                      |
| --------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Embedding | `fake-lexical-embedding` | die deterministische lexikalische Baseline aus `apps/api/src/eval/lexical-embedding-provider.ts` (Hashed Bag of Words, 768 Dim.) |
| Chat      | `fake-scripted-chat`     | eine fest geskriptete Antwort, die im ersten Satz sagt, dass sie von einem Fake-Modell stammt                                    |

Folgen: Scores und Rangfolgen spiegeln **gemeinsame Wörter**, nicht Bedeutung; die Chat-Antwort
ist **keine echte Modellausgabe**. API, Datenbank, Chunking, pgvector-Suche, Prompt-Building,
SSE-Streaming und UI sind echt. Die README weist unter dem ersten Bild darauf hin.

| Datei                          | Inhalt                                              | Fake-Anteil                       |
| ------------------------------ | --------------------------------------------------- | --------------------------------- |
| `welcome-light.webp`           | Welcome mit Live-Status                             | –                                 |
| `knowledge-bases-light.webp`   | Knowledge-Base-Übersicht (Demo + Eval-Datensatz)    | Modellname der Embeddings         |
| `collection-detail-light.webp` | Collection-Detail mit Upload und Dokumentstatus     | Modellname der Embeddings         |
| `document-chunks-light.webp`   | Chunks eines Dokuments (Offsets, Überschriftenpfad) | –                                 |
| `chat-sources-light.webp`      | Chat mit Quellen und Zitat (hell)                   | **Antworttext: geskriptet**       |
| `chat-sources-dark.webp`       | dasselbe im Dark Mode                               | **Antworttext: geskriptet**       |
| `playground-light.webp`        | Playground mit Scores/Distanzen (README-Kopfbild)   | Scores der lexikalischen Baseline |
| `playground-dark.webp`         | dasselbe im Dark Mode                               | Scores der lexikalischen Baseline |
| `settings-light.webp`          | Settings mit Provider-Konfiguration                 | Modellnamen                       |

## Neu aufnehmen (empfohlen: mit echten Modellen)

Sobald Modelle installiert sind, sollten die Bilder mit echten Modellen ersetzt und der Hinweis in
der README entfernt bzw. angepasst werden.

1. Eigene Datenbank verwenden, damit Entwicklungsdaten unberührt bleiben, z. B.
   `docker compose exec postgres psql -U raglab -c 'CREATE DATABASE raglab_screens'` und
   `DATABASE_URL=…/raglab_screens pnpm db:migrate`.
2. API mit dieser Datenbank starten (`DATABASE_URL=…/raglab_screens pnpm dev:api`), Web-App mit
   `pnpm dev:web`.
3. `pnpm demo:seed` und optional
   `pnpm demo:seed --dir eval/datasets/raglab-docs --name "Evaluation dataset" --description "Self-written evaluation documents (eval/datasets/raglab-docs)"`.
4. Browser mit **1280 px** Viewport-Breite (Höhe 800–1250 px je nach Seite), Theme über
   **Settings → Theme** oder `prefers-color-scheme`. Aufgenommene Seiten:
   `/`, `/knowledge-bases`, `/knowledge-bases/<id>`, ein Dokument (zu **Chunks** gescrollt),
   `/chat?collection=<id>` mit der Frage „How long does Kettlebird wait before the second retry?“
   und angeklicktem Zitat **[1]**, `/playground?collection=<id>&q=<dieselbe Frage>&topK=5`,
   `/settings`.
5. Als WebP speichern: `cwebp -q 82 -m 6 shot.png -o docs/images/<name>.webp` (Ziel: unter
   100 KB pro Bild). Dateinamen beibehalten, damit README-Links und Alt-Texte passen; Alt-Texte bei
   geändertem Inhalt anpassen.
6. Datenbank wieder löschen (`DROP DATABASE raglab_screens`).

Die Aufnahmen 2026-11-02 wurden per Chrome im Headless-Modus über das DevTools-Protokoll
gesteuert (Viewport 1280 px, `deviceScaleFactor` 1); das Hilfsskript und der Fake-Ollama-Server
sind bewusst **nicht** Teil des Repositorys – Bilder mit echten Modellen sind der bessere Weg.
