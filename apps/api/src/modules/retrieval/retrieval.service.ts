import type {
  RetrievalResult,
  RetrievalSearchRequest,
  RetrievalSearchResponse,
} from '@raglab/shared';
import { MAX_TOP_K, type AppConfig } from '../../config/env.js';
import { AppError, badRequest, conflict } from '../../http/errors.js';
import type { CollectionsService } from '../collections/collections.service.js';
import {
  assertEmbeddings,
  EmbeddingProviderError,
  type EmbeddingProvider,
} from '../embeddings/embedding-provider.js';
import type { RetrievalRepository, RetrievedChunk } from './retrieval.repository.js';
import { toScore } from './similarity.js';

export interface RetrievalService {
  /**
   * Embeds the query with the configured provider and returns the `topK` nearest chunks of the
   * collection. An empty result is not an error (`results: []` with `emptyReason`).
   *
   * Errors (`AppError`): `400 VALIDATION_ERROR`, `404 COLLECTION_NOT_FOUND`,
   * `409 EMBEDDING_MODEL_MISMATCH`, `502 EMBEDDING_PROVIDER_ERROR`,
   * `503 EMBEDDING_PROVIDER_UNAVAILABLE`, `503 EMBEDDING_DIMENSION_MISMATCH`.
   * When `signal` aborts, it rejects with the signal's reason.
   */
  search(request: RetrievalSearchRequest, signal?: AbortSignal): Promise<RetrievalSearchResponse>;
}

export interface RetrievalServiceDependencies {
  repository: RetrievalRepository;
  embeddingProvider: EmbeddingProvider;
  /** Embedding settings and document counts of the collection (via its service). */
  collections: Pick<CollectionsService, 'get'>;
  config: AppConfig['retrieval'];
  /** Dimension of the `chunks.embedding` column (`EMBEDDING_COLUMN_DIMENSIONS`). */
  columnDimensions: number;
}

/** Provider failures that are temporary: retrying later may succeed. */
const UNAVAILABLE_PROVIDER_CODES = new Set(['PROVIDER_UNREACHABLE', 'PROVIDER_TIMEOUT']);

const MIN_SCORE_LOWER = -1;
const MIN_SCORE_UPPER = 1;

export function createRetrievalService({
  repository,
  embeddingProvider: provider,
  collections,
  config,
  columnDimensions,
}: RetrievalServiceDependencies): RetrievalService {
  return {
    async search(request, signal) {
      const { query, topK, minScore } = validate(request, config);

      // 404 COLLECTION_NOT_FOUND for unknown collections.
      const collection = await collections.get(request.collectionId);
      const collectionModel = {
        provider: collection.embeddingProvider,
        model: collection.embeddingModel,
        dimensions: collection.embeddingDimensions,
      };
      const providerModel = {
        provider: provider.id,
        model: provider.model,
        dimensions: provider.dimensions,
      };
      // Vectors of different models live in different spaces: comparing them yields
      // meaningless distances, so the search is refused instead of returning wrong results.
      if (
        collectionModel.provider !== providerModel.provider ||
        collectionModel.model !== providerModel.model ||
        collectionModel.dimensions !== providerModel.dimensions
      ) {
        throw conflict(
          'EMBEDDING_MODEL_MISMATCH',
          `The collection was embedded with "${collectionModel.model}" (${collectionModel.provider}, ` +
            `${collectionModel.dimensions} dimensions), but the server is configured for ` +
            `"${providerModel.model}" (${providerModel.provider}, ${providerModel.dimensions} dimensions). ` +
            'Restore the original embedding configuration or create a new collection.',
          {
            collectionProvider: collectionModel.provider,
            collectionModel: collectionModel.model,
            collectionDimensions: collectionModel.dimensions,
            providerId: providerModel.provider,
            providerModel: providerModel.model,
            providerDimensions: providerModel.dimensions,
          },
        );
      }
      if (provider.dimensions !== columnDimensions) {
        throw new AppError(
          503,
          'EMBEDDING_DIMENSION_MISMATCH',
          `EMBEDDING_DIMENSIONS is ${provider.dimensions}, but the database column chunks.embedding ` +
            `has ${columnDimensions} dimensions.`,
          { expected: columnDimensions, actual: provider.dimensions },
        );
      }

      const response = (
        results: RetrievalResult[],
        timings: RetrievalSearchResponse['timings'],
        emptyReason?: RetrievalSearchResponse['emptyReason'],
      ): RetrievalSearchResponse => ({
        collectionId: collection.id,
        query,
        topK,
        minScore,
        embedding: providerModel,
        results,
        ...(emptyReason ? { emptyReason } : {}),
        timings,
      });

      // Nothing searchable: answer without calling the provider.
      if (collection.documentCount === 0) {
        return response([], { embeddingMs: 0, searchMs: 0 }, 'collection_empty');
      }
      if (collection.readyDocumentCount === 0) {
        return response([], { embeddingMs: 0, searchMs: 0 }, 'no_indexed_chunks');
      }

      const embeddingStart = performance.now();
      const embedding = await embedQuery(provider, query, signal);
      const embeddingMs = elapsedSince(embeddingStart);
      signal?.throwIfAborted();

      const searchStart = performance.now();
      const rows = await repository.search({
        collectionId: collection.id,
        embedding,
        limit: topK,
      });
      const searchMs = elapsedSince(searchStart);

      const results = applyMinScore(rankResults(rows), minScore);
      const emptyReason =
        results.length > 0
          ? undefined
          : rows.length === 0
            ? 'no_indexed_chunks'
            : 'below_min_score';
      return response(results, { embeddingMs, searchMs }, emptyReason);
    },
  };
}

interface ValidatedRequest {
  query: string;
  topK: number;
  minScore: number | null;
}

/**
 * Validates independently of the HTTP schema: the service is also used by chat, playground,
 * evaluation and MCP. Violations → `400 VALIDATION_ERROR`.
 */
function validate(
  request: RetrievalSearchRequest,
  config: AppConfig['retrieval'],
): ValidatedRequest {
  const query = typeof request.query === 'string' ? request.query.trim() : '';
  if (query.length === 0) {
    throw badRequest('VALIDATION_ERROR', 'query must not be blank', [
      { location: 'body/query', message: 'must not be blank' },
    ]);
  }
  if (query.length > config.maxQueryChars) {
    throw badRequest(
      'VALIDATION_ERROR',
      `query must not be longer than ${config.maxQueryChars} characters`,
      [
        {
          location: 'body/query',
          message: `must NOT have more than ${config.maxQueryChars} characters`,
        },
      ],
    );
  }
  const topK = request.topK ?? config.defaultTopK;
  if (!Number.isInteger(topK) || topK < 1 || topK > MAX_TOP_K) {
    throw badRequest('VALIDATION_ERROR', `topK must be an integer between 1 and ${MAX_TOP_K}`, [
      { location: 'body/topK', message: `must be an integer between 1 and ${MAX_TOP_K}` },
    ]);
  }
  const minScore = request.minScore ?? null;
  if (
    minScore !== null &&
    (!Number.isFinite(minScore) || minScore < MIN_SCORE_LOWER || minScore > MIN_SCORE_UPPER)
  ) {
    throw badRequest('VALIDATION_ERROR', 'minScore must be a number between -1 and 1', [
      { location: 'body/minScore', message: 'must be a number between -1 and 1' },
    ]);
  }
  return { query, topK, minScore };
}

async function embedQuery(
  provider: EmbeddingProvider,
  query: string,
  signal: AbortSignal | undefined,
): Promise<number[]> {
  try {
    const vectors = await provider.embed([query], signal);
    assertEmbeddings(vectors, 1, provider.dimensions);
    return vectors[0] ?? [];
  } catch (error) {
    if (error instanceof EmbeddingProviderError) {
      throw toProviderAppError(error);
    }
    throw error;
  }
}

/**
 * Provider failures while embedding the query: unreachable or timed out → `503
 * EMBEDDING_PROVIDER_UNAVAILABLE` (temporary, retry later); everything else (model missing,
 * wrong dimension, invalid answer) → `502 EMBEDDING_PROVIDER_ERROR` (the upstream answered
 * wrongly). `details.providerCode` keeps the provider's code. Messages never contain the query.
 */
export function toProviderAppError(error: EmbeddingProviderError): AppError {
  const details = {
    providerCode: error.code,
    ...(error.details.hint ? { hint: error.details.hint } : {}),
  };
  return UNAVAILABLE_PROVIDER_CODES.has(error.code)
    ? new AppError(503, 'EMBEDDING_PROVIDER_UNAVAILABLE', error.message, details)
    : new AppError(502, 'EMBEDDING_PROVIDER_ERROR', error.message, details);
}

/**
 * Sorts by ascending distance (stable; ties by document and chunk index, so equal input gives
 * equal output) and assigns gapless 1-based ranks. Needed because `relaxed_order` may return
 * rows slightly out of order.
 */
export function rankResults(rows: readonly RetrievedChunk[]): RetrievalResult[] {
  const sorted = [...rows].sort(
    (a, b) =>
      a.distance - b.distance ||
      a.documentId.localeCompare(b.documentId) ||
      a.chunkIndex - b.chunkIndex,
  );
  return sorted.map((row, index) => ({
    rank: index + 1,
    chunkId: row.chunkId,
    documentId: row.documentId,
    filename: row.filename,
    chunkIndex: row.chunkIndex,
    headingPath: row.headingPath,
    content: row.content,
    startOffset: row.startOffset,
    endOffset: row.endOffset,
    distance: row.distance,
    score: toScore(row.distance),
  }));
}

/**
 * Drops results with `score < minScore` and ranks the rest again (gapless). Shared with the
 * playground, which flags instead of hiding them but must select exactly what chat receives.
 */
export function applyMinScore(
  results: readonly RetrievalResult[],
  minScore: number | null,
): RetrievalResult[] {
  if (minScore === null) {
    return [...results];
  }
  return results
    .filter((result) => result.score >= minScore)
    .map((result, index) => ({ ...result, rank: index + 1 }));
}

/** Milliseconds since `start`, rounded to 0.1 ms. */
function elapsedSince(start: number): number {
  return Math.round((performance.now() - start) * 10) / 10;
}
