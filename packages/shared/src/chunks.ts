/**
 * How a text is split: `markdown` additionally splits at ATX headings and tracks heading paths,
 * `code` splits source code at top-level declarations and never inside a line (ADR 0004).
 */
export type ChunkingFormat = 'markdown' | 'text' | 'code';

/** A stored chunk of a document, without its embedding vector. */
export interface ChunkDto {
  id: string;
  documentId: string;
  collectionId: string;
  /** 0-based position within the document, without gaps. */
  chunkIndex: number;
  /** Exactly `documentContent.slice(startOffset, endOffset)`. */
  content: string;
  /** Offsets in UTF-16 code units of the normalised text (`GET /api/documents/:id/content`). */
  startOffset: number;
  endOffset: number;
  charCount: number;
  /** ≈ `charCount / 4` – informative only, not a model tokenizer. */
  tokenEstimate: number | null;
  /**
   * Enclosing Markdown headings, outermost first; `[]` for plain text. Source code:
   * `[path, symbol]` (symbol only when one was recognised).
   */
  headingPath: string[];
  /** Length of the leading part repeated from the preceding chunk (0 = no overlap). */
  overlapChars: number;
  /** 1-based first and last line of the chunk; `null` for chunks stored before prompt 017. */
  startLine: number | null;
  endLine: number | null;
  /** Enclosing top-level declaration(s) of source code (`class TreeFactory`), else `null`. */
  symbol: string | null;
  /** Whether an embedding is stored (embeddings follow with prompt 006). */
  hasEmbedding: boolean;
  createdAt: string;
}

/** Response of `GET /api/documents/:id/chunks`, ordered by `chunkIndex`. */
export interface DocumentChunksResponse {
  documentId: string;
  chunks: ChunkDto[];
}

/** Body of `POST /api/chunking/preview`; omitted sizes fall back to the server configuration. */
export interface ChunkPreviewRequest {
  text: string;
  format: ChunkingFormat;
  /** Language for `format: 'code'` (declaration heuristics), e.g. `typescript`; default generic. */
  language?: string;
  targetSize?: number;
  overlap?: number;
}

/** A chunk computed by the preview (nothing is stored). */
export interface ChunkPreviewItem {
  chunkIndex: number;
  content: string;
  startOffset: number;
  endOffset: number;
  charCount: number;
  tokenEstimate: number;
  headingPath: string[];
  overlapChars: number;
  startLine: number;
  endLine: number;
  symbol: string | null;
}

/**
 * Response of `POST /api/chunking/preview`. The input is normalised like an upload first;
 * offsets refer to `normalizedText`.
 */
export interface ChunkPreviewResponse {
  options: { targetSize: number; overlap: number; format: ChunkingFormat };
  normalizedText: string;
  chunks: ChunkPreviewItem[];
}
