export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';

/** Metadata derived from the document during upload. Further keys may be added later. */
export interface DocumentMetadataFields {
  /** Text of the first Markdown heading (Markdown documents only). */
  title?: string;
  [key: string]: unknown;
}

/**
 * Language of a document, derived from its file extension by the server (never from the client):
 * `markdown` and `text` are prose, everything else is source code (ADR 0004).
 */
export type DocumentLanguage =
  | 'markdown'
  | 'text'
  | 'typescript'
  | 'javascript'
  | 'vue'
  | 'svelte'
  | 'astro'
  | 'html'
  | 'css'
  | 'scss'
  | 'json'
  | 'yaml'
  | 'toml'
  | 'shell'
  | 'python'
  | 'java'
  | 'kotlin'
  | 'go'
  | 'rust'
  | 'csharp'
  | 'sql';

/** Document metadata. The normalised text (`content`) is never part of this DTO. */
export interface DocumentDto {
  id: string;
  collectionId: string;
  /** Display name: the last segment of `path`, or the sanitised upload file name. */
  filename: string;
  /**
   * Relative path within the imported source (`packages/table/src/x.ts`), unique per collection;
   * `null` for documents uploaded without a path. Display and metadata only.
   */
  path: string | null;
  /** Derived from the extension (see {@link DocumentLanguage}). */
  language: DocumentLanguage;
  mimeType: string;
  sizeBytes: number;
  contentSha256: string;
  status: DocumentStatus;
  /** Only set when `status` is `failed`; meant for humans. */
  errorMessage: string | null;
  chunkCount: number;
  metadata: DocumentMetadataFields;
  createdAt: string;
  updatedAt: string;
}

/**
 * Query of `GET /api/collections/:id/documents`. Without `limit` the complete (filtered) list is
 * returned, as before prompt 017.
 */
export interface DocumentListQuery {
  /** Only documents whose `path` starts with this prefix (case-sensitive). */
  pathPrefix?: string;
  /** Page size, 1..1000. */
  limit?: number;
  /** Number of documents to skip (with `limit`). */
  offset?: number;
}

/**
 * Response of `GET /api/collections/:id/documents`: documents ordered by `path` (documents without
 * a path last, by upload time); `total` counts all documents matching the filter.
 */
export interface DocumentListResponse {
  items: DocumentDto[];
  total: number;
}

/**
 * Response of `POST /api/collections/:id/documents` (`202 Accepted`): the stored documents,
 * all with `status: 'pending'`, in upload order. Processing continues asynchronously.
 */
export interface UploadDocumentsResponse {
  documents: DocumentDto[];
}

/** Response of `GET /api/documents/:id/content`: the normalised text of the document. */
export interface DocumentContentResponse {
  documentId: string;
  content: string;
}

/** Error codes of `POST /api/collections/:id/documents` (besides generic ones like `VALIDATION_ERROR`). */
export type DocumentUploadErrorCode =
  | 'NO_FILE'
  | 'EMPTY_DOCUMENT'
  | 'INVALID_ENCODING'
  | 'MALFORMED_MULTIPART'
  | 'COLLECTION_NOT_FOUND'
  | 'DUPLICATE_DOCUMENT'
  | 'DUPLICATE_PATH'
  | 'INVALID_PATH'
  | 'FILE_TOO_LARGE'
  | 'TOO_MANY_FILES'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'UNSUPPORTED_MEDIA_TYPE';

/** Error codes of `POST /api/documents/:id/reindex` (besides generic ones like `VALIDATION_ERROR`). */
export type DocumentReindexErrorCode =
  'DOCUMENT_NOT_FOUND' | 'DOCUMENT_BUSY' | 'DOCUMENT_ALREADY_INDEXED' | 'INDEXING_UNAVAILABLE';
