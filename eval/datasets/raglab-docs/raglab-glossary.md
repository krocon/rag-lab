# RAG Glossary

Short definitions of the terms used throughout a retrieval-augmented generation (RAG) pipeline.

## Chunking

Chunking splits a document into smaller passages before indexing. Chunks must be small enough to be
specific and to fit into the model's context, yet large enough to carry a complete thought. A chunk
overlap repeats the end of one chunk at the start of the next so that a sentence cut at a boundary
is still found. Recording the heading path and the character offsets of each chunk makes it
possible to show the exact source passage later.

## Embeddings

An embedding model maps a text to a vector of fixed length, for example 768 numbers. Texts with
similar meaning end up close to each other in this vector space even if they share no words. The
same model must embed the documents and the queries; vectors from different models are not
comparable.

## Vector search and similarity

Vector search finds the stored chunk vectors closest to the query vector. Cosine distance is a
common measure: it ignores vector length and compares only direction. Approximate indexes such as
HNSW trade a little accuracy for much faster searches on large collections.

## Evaluation metrics

Recall at K measures which share of the relevant passages appears among the first K results. Mean
reciprocal rank (MRR) rewards putting the first relevant result near the top: rank one scores 1,
rank two scores 0.5, and so on. A fixed set of questions with known relevant passages makes changes
to chunking or models measurable instead of a matter of impression.
