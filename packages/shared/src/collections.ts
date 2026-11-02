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
  createdAt: string;
  updatedAt: string;
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
