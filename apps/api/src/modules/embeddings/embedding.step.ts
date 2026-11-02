import type { CollectionsService } from '../collections/collections.service.js';
import type { ChunksRepository } from '../chunking/chunks.repository.js';
import { IndexingError, type IndexingStep } from '../ingestion/document-indexer.js';
import {
  assertEmbeddings,
  EmbeddingProviderError,
  type EmbeddingProvider,
} from './embedding-provider.js';

export const EMBEDDING_STEP_NAME = 'embedding';

/** Appended to provider failures: the document can be retried once the cause is fixed. */
const RETRY_HINT = 'Then reindex the document.';

export interface EmbeddingStepDependencies {
  provider: EmbeddingProvider;
  /** Chunk data access of the chunking module (owner of the `chunks` table). */
  chunks: Pick<ChunksRepository, 'listWithoutEmbedding' | 'storeEmbeddings'>;
  /** Embedding settings of the document's collection (other modules only via services). */
  collections: Pick<CollectionsService, 'get'>;
  /** Dimension of the `chunks.embedding` column (`EMBEDDING_COLUMN_DIMENSIONS`). */
  columnDimensions: number;
}

export function embeddingModelMismatchMessage(
  collection: { provider: string; model: string; dimensions: number },
  provider: { provider: string; model: string; dimensions: number },
): string {
  const describe = (value: typeof collection) =>
    `"${value.model}" (${value.provider}, ${value.dimensions} dimensions)`;
  return (
    `EMBEDDING_MODEL_MISMATCH: the collection uses the embedding model ${describe(collection)}, ` +
    `but the server is configured for ${describe(provider)}. Models are never mixed within a ` +
    'collection: restore the original embedding configuration or create a new collection.'
  );
}

export function columnDimensionMismatchMessage(configured: number, column: number): string {
  return (
    `EMBEDDING_DIMENSIONS is ${configured}, but the database column chunks.embedding has ` +
    `${column} dimensions. Use a model with matching dimensions or migrate the column.`
  );
}

/**
 * Second indexing step (after chunking): embeds every chunk of the document that has no vector
 * yet and stores all vectors in one transaction. The document becomes `ready` only afterwards.
 *
 * Before calling the provider, it refuses to mix models: provider id, model and dimension must
 * equal the collection's, and the dimension must equal the database column.
 *
 * Consistency: all vectors are computed first (in memory, a few MB even for thousands of chunks)
 * and then written in a single transaction, so a document is either completely embedded or not
 * at all, and no transaction stays open while the (slow) provider works.
 */
export function createEmbeddingStep({
  provider,
  chunks,
  collections,
  columnDimensions,
}: EmbeddingStepDependencies): IndexingStep {
  return {
    name: EMBEDDING_STEP_NAME,
    async run(context, signal) {
      const { document } = context;
      if (provider.dimensions !== columnDimensions) {
        throw new IndexingError(
          columnDimensionMismatchMessage(provider.dimensions, columnDimensions),
        );
      }
      const collection = await collections.get(document.collectionId);
      const expected = {
        provider: collection.embeddingProvider,
        model: collection.embeddingModel,
        dimensions: collection.embeddingDimensions,
      };
      const actual = {
        provider: provider.id,
        model: provider.model,
        dimensions: provider.dimensions,
      };
      if (
        expected.provider !== actual.provider ||
        expected.model !== actual.model ||
        expected.dimensions !== actual.dimensions
      ) {
        throw new IndexingError(embeddingModelMismatchMessage(expected, actual));
      }

      const pending = await chunks.listWithoutEmbedding(document.id);
      if (pending.length === 0) {
        return;
      }
      signal.throwIfAborted();

      let vectors: number[][];
      try {
        vectors = await provider.embed(
          pending.map((chunk) => chunk.content),
          signal,
        );
        // Never trust an adapter blindly: count and length are checked again before storing.
        assertEmbeddings(vectors, pending.length, columnDimensions);
      } catch (error) {
        if (error instanceof EmbeddingProviderError) {
          throw new IndexingError(`Embedding failed: ${error.userMessage} ${RETRY_HINT}`, {
            cause: error,
          });
        }
        throw error;
      }

      signal.throwIfAborted();
      await chunks.storeEmbeddings(
        document.id,
        pending.map((chunk, index) => ({ chunkId: chunk.id, embedding: vectors[index] ?? [] })),
      );
    },
  };
}
