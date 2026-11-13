import type {
  ChunkDto,
  ChunkPreviewRequest,
  ChunkPreviewResponse,
  DocumentChunksResponse,
} from '@raglab/shared';
import type { AppConfig } from '../../config/env.js';
import { badRequest } from '../../http/errors.js';
import type { DocumentsService } from '../documents/documents.service.js';
import { normalizeText } from '../ingestion/normalize.js';
import { chunkText } from './chunker.js';
import type { ChunksRepository, StoredChunk } from './chunks.repository.js';

export interface ChunkingService {
  /** Stored chunks of a document ordered by `chunkIndex`; `404 DOCUMENT_NOT_FOUND` if unknown. */
  listByDocument(documentId: string): Promise<DocumentChunksResponse>;
  /** Chunks a text with the server's (or the given) options without storing anything. */
  preview(request: ChunkPreviewRequest): ChunkPreviewResponse;
}

export interface ChunkingServiceDependencies {
  repository: ChunksRepository;
  /** Other modules are used through their services only, never through their tables. */
  documents: Pick<DocumentsService, 'get'>;
  /** `CHUNK_SIZE` / `CHUNK_OVERLAP`. */
  defaults: AppConfig['chunking'];
}

export function createChunkingService({
  repository,
  documents,
  defaults,
}: ChunkingServiceDependencies): ChunkingService {
  return {
    async listByDocument(documentId) {
      // Throws 404 DOCUMENT_NOT_FOUND for unknown documents.
      await documents.get(documentId);
      const chunks = await repository.listByDocument(documentId);
      return { documentId, chunks: chunks.map(toChunkDto) };
    },

    preview({
      text,
      format,
      language,
      targetSize = defaults.targetSize,
      overlap = defaults.overlap,
    }) {
      if (overlap >= targetSize) {
        throw badRequest(
          'INVALID_CHUNKING_OPTIONS',
          `overlap (${overlap}) must be smaller than targetSize (${targetSize}).`,
          { targetSize, overlap },
        );
      }
      const normalizedText = normalizeText(text);
      const chunks = chunkText(normalizedText, { targetSize, overlap, format, language });
      return { options: { targetSize, overlap, format }, normalizedText, chunks };
    },
  };
}

export function toChunkDto(chunk: StoredChunk): ChunkDto {
  return {
    id: chunk.id,
    documentId: chunk.documentId,
    collectionId: chunk.collectionId,
    chunkIndex: chunk.chunkIndex,
    content: chunk.content,
    startOffset: chunk.startOffset,
    endOffset: chunk.endOffset,
    charCount: chunk.charCount,
    tokenEstimate: chunk.tokenEstimate,
    headingPath: chunk.headingPath,
    overlapChars: typeof chunk.metadata.overlapChars === 'number' ? chunk.metadata.overlapChars : 0,
    startLine: typeof chunk.metadata.startLine === 'number' ? chunk.metadata.startLine : null,
    endLine: typeof chunk.metadata.endLine === 'number' ? chunk.metadata.endLine : null,
    symbol: typeof chunk.metadata.symbol === 'string' ? chunk.metadata.symbol : null,
    hasEmbedding: chunk.hasEmbedding,
    createdAt: chunk.createdAt.toISOString(),
  };
}
