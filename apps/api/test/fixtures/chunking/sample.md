---
title: RAGLab sample
# a YAML comment, not a heading
---

RAGLab is a self-hosted workbench for retrieval-augmented generation. This preamble has no heading.

# Getting started

## Installation

### Docker

Start the database with Docker Compose. The container exposes PostgreSQL on port 5432 and ships with pgvector preinstalled. Wait until the health check reports "healthy" before running migrations!

```bash
# start PostgreSQL with pgvector
docker compose up -d postgres
pnpm db:migrate
```

#### Troubleshooting

If the port is taken, change it in `.env`. Does the container restart in a loop? Check the logs with `docker compose logs postgres`.

## Configuration

- `CHUNK_SIZE` – maximum chunk length in characters
- `CHUNK_OVERLAP` – characters repeated from the previous chunk
- `EMBEDDING_MODEL` – the model used for embeddings

# Concepts

### Chunking (level jump)

Chunks are cut at paragraph ends first, then at sentence ends, line ends and word ends. Umlauts like Größe, Übermaß and naïve stay intact, and so do emoji like 👩‍💻 or 😀. A very long token such as https://example.com/a/really/long/path/that/keeps/going/and/going/without/any/whitespace/at/all/until/it/finally/ends/here/index.html is cut hard only if it is longer than the target size.

Overlap repeats the end of the previous chunk. It starts at a sentence start when possible, otherwise at a word start, and never in the middle of a word.

# FAQ

## Why characters instead of tokens?

Characters are deterministic and provider-neutral. Token counts differ between models, so `tokenEstimate` is informative only.
