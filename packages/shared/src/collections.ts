/** A knowledge base. Timestamps are ISO 8601 strings. */
export interface CollectionDto {
  id: string;
  name: string;
  description: string | null;
  /** Embedding provider/model/dimensions are fixed when the collection is created. */
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimensions: number;
  documentCount: number;
  readyDocumentCount: number;
  chunkCount: number;
  /** Where the documents were imported from (`pnpm kb:import`); `null` if unknown. */
  source: CollectionSource | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Import source of a collection (ADR 0004). `url` never contains credentials: the server rejects
 * URLs with user info. `commit` is the full commit SHA the files were read from.
 */
export interface CollectionSource {
  kind: 'directory' | 'git';
  /** Repository URL without credentials (`https://github.com/owner/repo`); `null` if unknown. */
  url: string | null;
  /** Branch, tag or SHA that was requested or checked out; `null` if unknown. */
  ref: string | null;
  /** 40- or 64-character hex commit SHA; `null` if unknown. */
  commit: string | null;
  /** ISO 8601 time of the last import (set by the server). */
  importedAt: string;
}

/** Body of `PUT /api/collections/:id/source`. */
export interface SetCollectionSourceRequest {
  kind: 'directory' | 'git';
  url?: string | null;
  ref?: string | null;
  commit?: string | null;
}

/** Body of `POST /api/collections`. Embedding settings come from the server configuration. */
export interface CreateCollectionRequest {
  name: string;
  description?: string;
}

/** Body of `PATCH /api/collections/:id`. `description: null` clears the description. */
export interface UpdateCollectionRequest {
  name?: string;
  description?: string | null;
}

/** Response of `GET /api/collections` (complete list, no pagination in the MVP). */
export interface CollectionListResponse {
  items: CollectionDto[];
}
