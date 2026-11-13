import type { FastifyPluginAsync } from 'fastify';
import type { RetrievalSearchRequest, RetrievalSearchResponse } from '@raglab/shared';
import { MAX_TOP_K } from '../../config/env.js';
import { errorResponseSchema } from '../../http/errors.js';
import type { RetrievalService } from './retrieval.service.js';

export interface RetrievalRoutesOptions {
  retrieval: RetrievalService;
  /** `MAX_QUERY_CHARS` (the service checks the trimmed length again). */
  maxQueryChars: number;
  /** `RETRIEVAL_TOP_K`, shown in the OpenAPI description. */
  defaultTopK: number;
}

/** Characters of the query that may appear in debug logs. */
export const LOGGED_QUERY_PREFIX_CHARS = 40;

export const retrievalResultSchema = {
  type: 'object',
  required: [
    'rank',
    'chunkId',
    'documentId',
    'filename',
    'path',
    'language',
    'chunkIndex',
    'headingPath',
    'content',
    'startOffset',
    'endOffset',
    'startLine',
    'endLine',
    'symbol',
    'sourceUrl',
    'distance',
    'score',
  ],
  properties: {
    rank: { type: 'integer', minimum: 1, description: '1-based, gapless, by ascending distance' },
    chunkId: { type: 'string', format: 'uuid' },
    documentId: { type: 'string', format: 'uuid' },
    filename: { type: 'string' },
    path: {
      type: ['string', 'null'],
      description: 'Relative path of the document; null for uploads without a path',
    },
    language: { type: 'string', description: 'Derived from the file extension' },
    chunkIndex: { type: 'integer' },
    headingPath: { type: 'array', items: { type: 'string' } },
    content: { type: 'string' },
    startOffset: { type: 'integer', description: 'UTF-16 code units in the normalised text' },
    endOffset: { type: 'integer', description: 'UTF-16 code units in the normalised text' },
    startLine: { type: ['integer', 'null'], description: '1-based; null for older chunks' },
    endLine: { type: ['integer', 'null'], description: '1-based; null for older chunks' },
    symbol: {
      type: ['string', 'null'],
      description: 'Enclosing top-level declaration(s) of source code',
    },
    sourceUrl: {
      type: ['string', 'null'],
      description: 'Link to the lines at the imported commit (GitHub, GitLab, Bitbucket, Codeberg)',
    },
    distance: {
      type: 'number',
      description:
        'Cosine distance as returned by the pgvector operator `<=>`, 0..2. Lower = more similar.',
    },
    score: {
      type: 'number',
      description: '`1 - distance` (cosine similarity), -1..1. Higher = more similar.',
    },
  },
} as const;

export const retrievalRoutes: FastifyPluginAsync<RetrievalRoutesOptions> = async (
  app,
  { retrieval, maxQueryChars, defaultTopK },
) => {
  app.post<{ Body: RetrievalSearchRequest; Reply: RetrievalSearchResponse }>(
    '/retrieval/search',
    {
      schema: {
        tags: ['retrieval'],
        summary: 'Semantic search in one collection (top-K chunks by cosine distance)',
        description: [
          'Embeds `query` with the configured embedding provider and returns the `topK` nearest',
          'chunks of the collection (only `ready` documents with embedded chunks).',
          'Each result has `distance` (pgvector `<=>`, 0..2, lower = more similar) and',
          '`score = 1 - distance` (-1..1, higher = more similar); results are ordered by',
          'ascending distance. `minScore` drops results after the top-K search.',
          'An empty result is not an error: `200` with `results: []` and `emptyReason`.',
          'A collection embedded with another model than the configured one →',
          '`409 EMBEDDING_MODEL_MISMATCH`; provider unreachable or timed out →',
          '`503 EMBEDDING_PROVIDER_UNAVAILABLE`; other provider failures →',
          '`502 EMBEDDING_PROVIDER_ERROR`.',
        ].join(' '),
        body: {
          type: 'object',
          required: ['collectionId', 'query'],
          additionalProperties: false,
          properties: {
            collectionId: { type: 'string', format: 'uuid' },
            query: {
              type: 'string',
              minLength: 1,
              maxLength: maxQueryChars,
              description: `Trimmed; 1..${maxQueryChars} characters (MAX_QUERY_CHARS)`,
            },
            topK: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_TOP_K,
              description: `Defaults to RETRIEVAL_TOP_K (${defaultTopK})`,
            },
            minScore: {
              type: 'number',
              minimum: -1,
              maximum: 1,
              description: 'Drop results with `score < minScore`',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            required: [
              'collectionId',
              'query',
              'topK',
              'minScore',
              'embedding',
              'results',
              'timings',
            ],
            properties: {
              collectionId: { type: 'string', format: 'uuid' },
              query: { type: 'string', description: 'The trimmed query' },
              topK: { type: 'integer' },
              minScore: { type: ['number', 'null'] },
              embedding: {
                type: 'object',
                required: ['provider', 'model', 'dimensions'],
                properties: {
                  provider: { type: 'string' },
                  model: { type: 'string' },
                  dimensions: { type: 'integer' },
                },
              },
              results: { type: 'array', items: retrievalResultSchema },
              emptyReason: {
                type: 'string',
                enum: ['collection_empty', 'no_indexed_chunks', 'below_min_score'],
                description: 'Only present when `results` is empty',
              },
              timings: {
                type: 'object',
                required: ['embeddingMs', 'searchMs'],
                properties: {
                  embeddingMs: { type: 'number' },
                  searchMs: { type: 'number' },
                },
              },
            },
          },
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          502: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const controller = new AbortController();
      // Stop the provider request when the client disconnects before the response is sent.
      reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) {
          controller.abort(new Error('client closed the request'));
        }
      });
      const response = await retrieval.search(request.body, controller.signal);
      // Queries and chunk contents are user data: never at info level. Debug logs show a short
      // prefix only – enough to tell requests apart while tuning retrieval locally.
      request.log.info(
        {
          collectionId: response.collectionId,
          topK: response.topK,
          minScore: response.minScore,
          queryChars: response.query.length,
          results: response.results.length,
          emptyReason: response.emptyReason,
          timings: response.timings,
        },
        'retrieval search',
      );
      request.log.debug(
        { queryPrefix: response.query.slice(0, LOGGED_QUERY_PREFIX_CHARS) },
        'retrieval search query (truncated)',
      );
      return response;
    },
  );
};
