export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';

/** Metadata derived from the document during upload. Further keys may be added later. */
export interface DocumentMetadataFields {
  /** Text of the first Markdown heading (Markdown documents only). */
  title?: string;
  [key: string]: unknown;
}

/** Document metadata. The normalised text (`content`) is never part of this DTO. */
export interface DocumentDto {
  id: string;
  collectionId: string;
  filename: string;
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

/** Response of `GET /api/collections/:id/documents` (complete list, no pagination in the MVP). */
export interface DocumentListResponse {
  items: DocumentDto[];
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
  | 'FILE_TOO_LARGE'
  | 'TOO_MANY_FILES'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'UNSUPPORTED_MEDIA_TYPE';

/** Error codes of `POST /api/documents/:id/reindex` (besides generic ones like `VALIDATION_ERROR`). */
export type DocumentReindexErrorCode =
  'DOCUMENT_NOT_FOUND' | 'DOCUMENT_BUSY' | 'DOCUMENT_ALREADY_INDEXED' | 'INDEXING_UNAVAILABLE';
