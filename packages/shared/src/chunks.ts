/** How a text is split: `markdown` additionally splits at ATX headings and tracks heading paths. */
export type ChunkingFormat = 'markdown' | 'text';

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
  /** Enclosing Markdown headings, outermost first; `[]` for plain text. */
  headingPath: string[];
  /** Length of the leading part repeated from the preceding chunk (0 = no overlap). */
  overlapChars: number;
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
