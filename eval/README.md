# RAGLab retrieval evaluation

This directory holds the evaluation datasets and (git-ignored) results of `pnpm eval`. The
background, metric definitions and the reference runs are documented in German in
[docs/evaluation.md](../docs/evaluation.md).

```text
eval/
  datasets/raglab-docs/   14 self-written English documents (.md/.txt) + queries.jsonl (40 queries)
  results/                JSON result of every run (git-ignored)
```

## Running

```bash
pnpm db:up && pnpm db:migrate        # PostgreSQL with pgvector
pnpm eval                            # configured embedding model via Ollama (EMBEDDING_MODEL)
pnpm eval --baseline                 # deterministic lexical baseline – no Ollama needed
pnpm eval --injection                # live prompt-injection check with CHAT_MODEL (report only)
pnpm eval --help                     # all options (--dataset, --out, --keep)
```

`pnpm eval` creates a temporary collection in the database of `DATABASE_URL`, uploads every
document through the real services (upload validation, normalisation, chunking, embedding), runs
each query through the retrieval service (`topK` = 10) and prints Recall@K, Precision@K,
Hit-Rate@K and MRR for K = 1, 3, 5, 10 – at document and at section level. The collection is
deleted afterwards, also when the run fails or is interrupted with Ctrl+C (`--keep` keeps it).

Without a reachable Ollama or without the configured model, the command stops with a short message
(it never downloads models; install them yourself, e.g. `ollama pull nomic-embed-text`).

The deterministic smoke test `apps/api/test/integration/eval.int.test.ts` runs the same flow with
the lexical baseline in `pnpm test:integration` and in CI. It checks the wiring, not the quality of
an embedding model.

## Dataset format

A dataset is a directory with documents (`*.md`, `*.txt`, uploaded as they are) and a
`queries.jsonl` file – one JSON object per line:

```json
{
  "id": "q01",
  "query": "How often should I feed a sourdough starter?",
  "relevant": [{ "document": "sourdough-baking.md", "heading": "Feeding the starter" }]
}
```

| Field      | Type                     | Meaning                                                     |
| ---------- | ------------------------ | ----------------------------------------------------------- |
| `id`       | string, `[A-Za-z0-9_-]+` | Unique query id                                             |
| `query`    | non-empty string         | The question, sent to the retrieval service as is           |
| `relevant` | array, at least one      | Relevance anchors; several anchors = several relevant parts |

A relevance **anchor** points to a stable part of the text, never to chunk ids – changing the
chunking does not break the gold labels:

| Anchor                                   | Relevant chunks                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| `{ "document": "a.md" }`                 | every chunk of the document                                            |
| `{ "document": "a.md", "heading": "X" }` | chunks whose heading path contains heading `X` (section + subsections) |
| `{ "document": "a.txt", "marker": "…" }` | chunks containing the whole marker text (whitespace-insensitive)       |

Rules, checked with zod when the dataset is loaded (every problem is reported with its line):

- `document` must be a file of the dataset; `heading` must be the exact text of a Markdown heading
  that occurs once in that document; `marker` must occur exactly once (at least 3 characters).
- An anchor has either `heading` or `marker`, not both. No duplicate ids, no duplicate anchors.
- Unknown fields are rejected.

Plain-text documents have no headings, so use markers there. A marker that a chunk boundary cuts in
two cannot be matched; the run lists such anchors under "Anchors no chunk matches".

## Metrics in short

`K` counts retrieved chunks. At **document level** a chunk is relevant if its document is
referenced by an anchor; at **section level** if it matches an anchor.

- **Recall@K** – share of relevant items (documents or anchors) found in the top K.
- **Precision@K** – relevant chunks in the top K divided by K.
- **Hit-Rate@K** – 1 if at least one of the top K chunks is relevant.
- **MRR** – mean of 1 / rank of the first relevant chunk (0 if none in the top 10).

## Comparing runs

Every result file stores the dataset hash, provider, model, dimensions, `CHUNK_SIZE`,
`CHUNK_OVERLAP`, `topK`, the Git commit (and whether the tree was dirty) plus per-query rankings.
Compare runs only when the dataset hash matches; change one parameter at a time, e.g.

```bash
CHUNK_SIZE=800 CHUNK_OVERLAP=100 pnpm eval
jq '.summary.section.atK["5"]' eval/results/*.json
```

## Contributing queries or documents

Write the text yourself (no copied third-party content), keep topics distinguishable, and phrase
queries the way a user would ask – paraphrased, not copied from the document. Run
`pnpm --filter @raglab/api test` afterwards: the loader test validates the bundled dataset.
