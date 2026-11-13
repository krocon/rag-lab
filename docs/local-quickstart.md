# Local quick start: run RAGLab with real models

A short walkthrough for running RAGLab on your own machine with real Ollama models and loading the
first data. It condenses the [README](../README.md#quick-start); see there for the container
variant and all configuration options.

## Requirements

- **Docker** with Compose (for PostgreSQL + pgvector)
- **[Ollama](https://ollama.com)** running natively (on macOS containers have no GPU access)
- **Node.js ≥ 24.15** and **pnpm**
- A `.env` file in the repository root (`cp .env.example .env`; never commit it)

## Start

```bash
# 1. Pull the models named in .env (RAGLab never downloads models for you)
ollama pull nomic-embed-text      # EMBEDDING_MODEL, 768 dimensions
ollama pull llama3.2              # CHAT_MODEL

# 2. In the repository root
pnpm install
pnpm db:up          # PostgreSQL + pgvector on 127.0.0.1:5432
pnpm db:migrate     # applies the SQL migrations
pnpm dev            # API on :3000, web app on :4200

# 3. Check that Ollama and both models are detected
curl -s 'localhost:3000/api/system/providers?verify=true'
```

Open <http://localhost:4200>. If port 5432 is taken, change `POSTGRES_PORT` **and** the port in
`DATABASE_URL`.

## Which data to load

### First: the bundled demo dataset

In a second terminal:

```bash
pnpm demo:seed            # creates or reuses the knowledge base "RAGLab Demo"
pnpm demo:seed --reset    # rebuilds it from scratch
```

This uploads 13 short documents about _Kettlebird_, a fictional job scheduler
([examples/demo-knowledge-base](../examples/demo-knowledge-base)). It is the best starting point
for three reasons:

- **The model cannot know the answers.** Kettlebird is invented, so every correct answer
  demonstrably comes from the retrieved sources, not from training data.
- **It ships with test questions and expected answers**, for example _"How long does Kettlebird
  wait before the second retry?"_ (60 seconds). The full list, including a question that is
  deliberately not answerable, is in the
  [demo README](../examples/demo-knowledge-base/README.md#example-questions).
- **It contains a deliberate prompt-injection file** (`prompt-injection-demo.md`) to see how the
  pipeline treats instructions hidden in a document.

### Second: your own knowledge base

Once the demo works: **Knowledge Bases → New knowledge base**, then drop Markdown, text or source
files on the upload area.

To load a whole project – source code, Markdown and text – point `pnpm kb:import` at a local
directory or a Git URL. It keeps the relative paths, skips `node_modules`, `dist`, build output,
lockfiles, binaries, minified files, everything in `.gitignore` and never uploads secrets
(`.env*`, keys):

```bash
pnpm kb:import --source ~/code/my-project --dry-run            # what would be imported, and why not
pnpm kb:import --source ~/code/my-project --name "My project"  # import and wait for indexing
pnpm kb:import --source https://github.com/owner/repo --name "Repo" --ref main
pnpm kb:import --source ~/code/my-project --name "My project" --sync   # later: apply changes
```

Start with a curated selection (`--include`, `--exclude` or a `.raglabignore` file in the source
directory): generated API reference pages are large and repetitive and can crowd out the passages
you actually want to find. Sources are cited as `path:lines` and, for GitHub/GitLab/Bitbucket/
Codeberg repositories, link to the file at the imported commit. Details: README,
[Import a directory or repository](../README.md#import-a-directory-or-repository).

Note: the demo dataset is English. How well `nomic-embed-text` retrieves texts in other languages
(for example German) has not been checked here – try your queries in the **Retrieval Playground**
before relying on the results.

## How to tell it really runs on real models

- **Settings** and the playground diagnostics show `nomic-embed-text` as the embedding model, not
  `fake-lexical-embedding`.
- A chat answer does **not** start with "Scripted answer from a fake test model".

## If something fails

The error messages name the cause (model not installed, Ollama not reachable, wrong embedding
dimension). The table with fixes is in the README under
[Check the AI provider](../README.md#check-the-ai-provider).
