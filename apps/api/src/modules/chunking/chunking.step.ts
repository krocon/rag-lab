import type { AppConfig } from '../../config/env.js';
import { IndexingError, type IndexingStep } from '../ingestion/document-indexer.js';
import { languageForMimeType } from '../ingestion/file-type.js';
import { chunkingFormatFor, chunkText } from './chunker.js';
import type { ChunksRepository } from './chunks.repository.js';

export const CHUNKING_STEP_NAME = 'chunking';

export const NO_CHUNKS_MESSAGE = 'The document contains no text that could be split into chunks.';

export interface ChunkingStepDependencies {
  repository: Pick<ChunksRepository, 'replaceForDocument'>;
  /** Global `CHUNK_SIZE` / `CHUNK_OVERLAP` (no per-collection configuration yet). */
  options: AppConfig['chunking'];
  /** Replaceable for tests; defaults to the real chunker. */
  chunk?: typeof chunkText;
}

/**
 * First indexing step: chunks `documents.content` and replaces the document's chunks in one
 * transaction (embeddings stay `NULL` until prompt 006). Sets `context.chunkCount`, which the
 * indexer stores as `documents.chunk_count` when the document becomes `ready`.
 */
export function createChunkingStep({
  repository,
  options,
  chunk = chunkText,
}: ChunkingStepDependencies): IndexingStep {
  return {
    name: CHUNKING_STEP_NAME,
    async run(context, signal) {
      const { document } = context;
      const format = chunkingFormatFor(document.mimeType);
      const chunked = chunk(document.content, {
        targetSize: options.targetSize,
        overlap: options.overlap,
        format,
        language: languageForMimeType(document.mimeType),
      });
      if (chunked.length === 0) {
        throw new IndexingError(NO_CHUNKS_MESSAGE);
      }
      // Source code: the heading path is the file path, then the symbol (ADR 0004).
      const drafts =
        format === 'code'
          ? chunked.map((draft) => ({
              ...draft,
              headingPath: [document.path ?? document.filename, ...draft.headingPath],
            }))
          : chunked;
      signal.throwIfAborted();
      await repository.replaceForDocument(document, drafts);
      context.chunkCount = drafts.length;
    },
  };
}
