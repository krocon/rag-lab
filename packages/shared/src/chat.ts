/**
 * Contract of `POST /api/chat` – grounded answers streamed as Server-Sent Events.
 *
 * Errors found before the stream starts (validation, unknown collection, embedding model
 * mismatch, embedding provider failures) are answered as normal JSON in the error format
 * (`ApiErrorResponse`). Once the stream has started, the events arrive in this order:
 * `sources` → `token`* → `done` | `error`.
 */
export interface ChatRequest {
  collectionId: string;
  /** Trimmed by the server; 1..`MAX_QUESTION_CHARS` characters. */
  question: string;
  /** 1..100; defaults to `RETRIEVAL_TOP_K`. */
  topK?: number;
  /** -1..1; retrieved chunks with `score < minScore` are not used as sources. */
  minScore?: number;
}

/**
 * One source the model received. `n` is the number the answer cites as `[n]`; every source comes
 * from the retrieval result (stable `documentId`/`chunkId`).
 */
export interface ChatSource {
  /** 1-based citation number, equal to the retrieval rank. */
  n: number;
  documentId: string;
  chunkId: string;
  chunkIndex: number;
  filename: string;
  headingPath: string[];
  content: string;
  /** `1 - distance` (cosine similarity), -1..1, higher = more similar. */
  score: number;
  /** Cosine distance from `<=>`, 0..2, lower = more similar. */
  distance: number;
}

/** `answered`: the model was asked; `no_sources`: no usable source, the model was not called. */
export type ChatAnswerStatus = 'answered' | 'no_sources';

/** Data of the `sources` event – always the first event, before any token. */
export interface ChatSourcesEvent {
  sources: ChatSource[];
}

/** Data of a `token` event: the next piece of the answer text. */
export interface ChatTokenEvent {
  text: string;
}

/** Data of the `done` event – the last event of a successful stream. */
export interface ChatDoneEvent {
  answerStatus: ChatAnswerStatus;
  /** Source numbers cited as `[n]` that exist in `sources` (ascending, unique). */
  citedSources: number[];
  /** Cited numbers without a matching source (ascending, unique) – must not be linked. */
  unknownCitations: number[];
  /** Chat model that generated the answer; `null` when it was not called (`no_sources`). */
  model: string | null;
  /** Milliseconds, rounded to 0.1 ms. */
  timings: {
    /** Embedding the question (retrieval). */
    embeddingMs: number;
    /** Vector search (retrieval). */
    searchMs: number;
    /** From the provider request to the first token; `null` without tokens from the model. */
    firstTokenMs: number | null;
    /** From the provider request to the end of the answer; 0 when the model was not called. */
    generationMs: number;
    totalMs: number;
  };
}

/**
 * Data of the `error` event – the stream ends afterwards. Codes: `CHAT_PROVIDER_UNAVAILABLE`
 * (unreachable, timed out), `CHAT_PROVIDER_ERROR` (model missing, invalid answer, other),
 * `INTERNAL_ERROR`.
 */
export interface ChatErrorEvent {
  code: string;
  message: string;
}

/** All SSE events of `POST /api/chat`, discriminated by the SSE `event:` name. */
export type ChatStreamEvent =
  | { event: 'sources'; data: ChatSourcesEvent }
  | { event: 'token'; data: ChatTokenEvent }
  | { event: 'done'; data: ChatDoneEvent }
  | { event: 'error'; data: ChatErrorEvent };

export type ChatStreamEventName = ChatStreamEvent['event'];
