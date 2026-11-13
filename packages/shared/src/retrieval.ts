/**
 * Contract of `POST /api/retrieval/search` – the retrieval service shared by chat (008),
 * playground (011), evaluation (013) and the MCP server (014).
 *
 * Metric: cosine distance (pgvector `<=>`). `distance` and `score` are never interchangeable:
 * `distance` is the raw operator value (0..2, lower = more similar), `score = 1 - distance`
 * (-1..1, higher = more similar).
 */
export interface RetrievalSearchRequest {
  collectionId: string;
  /** Trimmed by the server; 1..`MAX_QUERY_CHARS` characters. */
  query: string;
  /** 1..100; defaults to `RETRIEVAL_TOP_K`. */
  topK?: number;
  /** -1..1; results with `score < minScore` are dropped after the top-K search. */
  minScore?: number;
}

export interface RetrievalResult {
  /** 1-based position without gaps, ordered by ascending `distance`. */
  rank: number;
  chunkId: string;
  documentId: string;
  filename: string;
  /** Relative path of the document (`null` for uploads without a path). */
  path: string | null;
  /** Language of the document, derived from its extension. */
  language: string;
  chunkIndex: number;
  headingPath: string[];
  content: string;
  /** 1-based line range of the chunk; `null` for chunks stored before prompt 017. */
  startLine: number | null;
  endLine: number | null;
  /** Enclosing top-level declaration(s) of source code, else `null`. */
  symbol: string | null;
  /**
   * Link to the lines in the repository at the imported commit
   * (`https://github.com/o/r/blob/<sha>/<path>#L10-L42`), only for known hosts; else `null`.
   */
  sourceUrl: string | null;
  /** Offsets in UTF-16 code units of the normalised document text. */
  startOffset: number;
  endOffset: number;
  /** Cosine distance from `<=>`, 0..2, lower = more similar. */
  distance: number;
  /** `1 - distance` (cosine similarity), -1..1, higher = more similar. */
  score: number;
}

/**
 * Why `results` is empty (only set when it is):
 * - `collection_empty` – the collection has no documents,
 * - `no_indexed_chunks` – no `ready` document with embedded chunks,
 * - `below_min_score` – chunks were found, but none reaches `minScore`.
 */
export type RetrievalEmptyReason = 'collection_empty' | 'no_indexed_chunks' | 'below_min_score';

export interface RetrievalSearchResponse {
  collectionId: string;
  /** The trimmed query that was embedded. */
  query: string;
  topK: number;
  minScore: number | null;
  /** Provider and model that embedded the query (equal to the collection's). */
  embedding: { provider: string; model: string; dimensions: number };
  results: RetrievalResult[];
  emptyReason?: RetrievalEmptyReason;
  /** Milliseconds; `embeddingMs` is 0 when no embedding was needed (empty collection). */
  timings: { embeddingMs: number; searchMs: number };
}
