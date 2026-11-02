import type { DocumentStatus } from './documents.js';
import type { RetrievalEmptyReason, RetrievalResult } from './retrieval.js';

/**
 * Contract of `POST /api/playground/search` – retrieval diagnostics (prompt 011).
 *
 * The playground calls the same retrieval service as chat and builds the chat prompt with the
 * same pure prompt builder, so it shows exactly what a chat question would retrieve and send.
 * `distance` (pgvector `<=>`, 0..2, lower = more similar) and `score = 1 - distance` (-1..1,
 * higher = more similar) keep their meaning from `RetrievalResult`.
 */
export interface PlaygroundSearchRequest {
  collectionId: string;
  /** Trimmed by the server; 1..`MAX_QUERY_CHARS` characters. */
  query: string;
  /** 1..100; defaults to `RETRIEVAL_TOP_K`. */
  topK?: number;
  /**
   * -1..1. Unlike `POST /api/retrieval/search`, results below `minScore` are **not** dropped
   * but flagged with `belowMinScore` (chat would not use them).
   */
  minScore?: number;
  /** Also return the messages chat would send to the model (`prompt`). No model is called. */
  includePrompt?: boolean;
}

/** A retrieval result plus what chat would do with it. */
export interface PlaygroundResult extends RetrievalResult {
  /** Chat would send this chunk to the model (within `CHAT_CONTEXT_CHAR_BUDGET`, ≥ `minScore`). */
  includedInChatContext: boolean;
  /** `score < minScore`: chat would drop it before building the prompt. */
  belowMinScore: boolean;
}

export interface EmbeddingModelInfo {
  provider: string;
  model: string;
  dimensions: number;
}

/** Index state of the collection at the time of the search. */
export interface PlaygroundCollectionStats {
  documentCount: number;
  documentsByStatus: Record<DocumentStatus, number>;
  /** All stored chunks of the collection. */
  chunkCount: number;
  /** Chunks with an embedding of `ready` documents – the ones the search can find. */
  searchableChunkCount: number;
  /** Chunks without an embedding (any document status) – never found by the search. */
  chunksWithoutEmbedding: number;
}

/** How the chat prompt would use the results. */
export interface PlaygroundChatContext {
  /** `CHAT_CONTEXT_CHAR_BUDGET`: characters of all `<source>` blocks together. */
  charBudget: number;
  /** Characters of the `<source>` blocks that fit. */
  usedChars: number;
  /** Results chat would send (`includedInChatContext`). */
  includedCount: number;
  /** Results ≥ `minScore` left out because the budget was exhausted. */
  omittedByBudgetCount: number;
  /** Results dropped because `score < minScore`. */
  belowMinScoreCount: number;
}

export type PlaygroundWarningCode =
  | 'COLLECTION_EMPTY'
  | 'NO_INDEXED_CHUNKS'
  | 'ALL_BELOW_MIN_SCORE'
  | 'CHUNKS_WITHOUT_EMBEDDING'
  | 'DOCUMENTS_NOT_READY'
  | 'DOCUMENTS_FAILED'
  | 'CONTEXT_BUDGET_TOO_SMALL'
  | 'QUERY_TOO_LONG_FOR_CHAT';

/** A problem worth knowing about; `message` is human-readable and contains no document text. */
export interface PlaygroundWarning {
  code: PlaygroundWarningCode;
  message: string;
}

/** The messages chat would send to the model – built without calling it. */
export interface PlaygroundPromptPreview {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  /** `false`: no source fits, chat answers with `noSourcesAnswer` and does not call the model. */
  wouldCallModel: boolean;
  /** The fixed chat answer without sources (only when `wouldCallModel` is `false`). */
  noSourcesAnswer?: string;
  /** Configured chat provider and model (`CHAT_PROVIDER`, `CHAT_MODEL`). */
  chatModel: { provider: string; model: string };
}

export interface PlaygroundSearchResponse {
  collectionId: string;
  /** The trimmed query that was embedded. */
  query: string;
  /** All top-K results in rank order, including those below `minScore`. */
  results: PlaygroundResult[];
  /** Why chat would get no retrieval result (only set then). */
  emptyReason?: RetrievalEmptyReason;
  stats: PlaygroundCollectionStats;
  embedding: {
    /** Fixed when the collection was created. */
    collection: EmbeddingModelInfo;
    /** Current configuration that embedded the query. */
    provider: EmbeddingModelInfo;
    /** Always `true` in a response – a mismatch is `409 EMBEDDING_MODEL_MISMATCH`. */
    matches: boolean;
  };
  search: {
    metric: 'cosine';
    /** pgvector operator. */
    operator: '<=>';
    /** `hnsw.iterative_scan` of the search transaction. */
    iterativeScan: string;
    /** `hnsw.ef_search` of the search transaction. */
    efSearch: number;
    topK: number;
    minScore: number | null;
  };
  chatContext: PlaygroundChatContext;
  warnings: PlaygroundWarning[];
  /** Milliseconds; `embeddingMs` is 0 when no embedding was needed (empty collection). */
  timings: { embeddingMs: number; searchMs: number };
  /** Only with `includePrompt: true`. */
  prompt?: PlaygroundPromptPreview;
}
