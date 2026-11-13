import type { FastifyPluginAsync } from 'fastify';
import type { PlaygroundSearchRequest, PlaygroundSearchResponse } from '@raglab/shared';
import { MAX_TOP_K } from '../../config/env.js';
import { errorResponseSchema } from '../../http/errors.js';
import { LOGGED_QUERY_PREFIX_CHARS, retrievalResultSchema } from '../retrieval/retrieval.routes.js';
import type { PlaygroundService } from './playground.service.js';

export interface PlaygroundRoutesOptions {
  playground: PlaygroundService;
  /** `MAX_QUERY_CHARS` (the retrieval service checks the trimmed length again). */
  maxQueryChars: number;
  /** `RETRIEVAL_TOP_K`, shown in the OpenAPI description. */
  defaultTopK: number;
}

const modelSchema = {
  type: 'object',
  required: ['provider', 'model', 'dimensions'],
  properties: {
    provider: { type: 'string' },
    model: { type: 'string' },
    dimensions: { type: 'integer' },
  },
} as const;

const countSchema = { type: 'integer', minimum: 0 } as const;

const playgroundResultSchema = {
  ...retrievalResultSchema,
  required: [
    ...retrievalResultSchema.required,
    'includedInChatContext',
    'belowMinScore',
    'embeddingHeader',
  ],
  properties: {
    ...retrievalResultSchema.properties,
    includedInChatContext: {
      type: 'boolean',
      description:
        'Chat would send this chunk to the model: score ≥ minScore and within CHAT_CONTEXT_CHAR_BUDGET',
    },
    embeddingHeader: {
      type: ['string', 'null'],
      description:
        'Header embedded in front of `content` (`File: …`, `Symbol: …`) for imported documents; null = only `content` was embedded',
    },
    belowMinScore: {
      type: 'boolean',
      description: '`score < minScore` – chat would drop it before building the prompt',
    },
  },
} as const;

const responseSchema = {
  type: 'object',
  required: [
    'collectionId',
    'query',
    'results',
    'stats',
    'embedding',
    'search',
    'chatContext',
    'warnings',
    'timings',
  ],
  properties: {
    collectionId: { type: 'string', format: 'uuid' },
    query: { type: 'string', description: 'The trimmed query' },
    results: {
      type: 'array',
      items: playgroundResultSchema,
      description: 'All top-K results by ascending distance, including those below minScore',
    },
    emptyReason: {
      type: 'string',
      enum: ['collection_empty', 'no_indexed_chunks', 'below_min_score'],
      description: 'Why chat would get no retrieval result (only set then)',
    },
    stats: {
      type: 'object',
      required: [
        'documentCount',
        'documentsByStatus',
        'chunkCount',
        'searchableChunkCount',
        'chunksWithoutEmbedding',
      ],
      properties: {
        documentCount: countSchema,
        documentsByStatus: {
          type: 'object',
          required: ['pending', 'processing', 'ready', 'failed'],
          properties: {
            pending: countSchema,
            processing: countSchema,
            ready: countSchema,
            failed: countSchema,
          },
        },
        chunkCount: countSchema,
        searchableChunkCount: {
          ...countSchema,
          description: 'Chunks with an embedding of ready documents (what the search can find)',
        },
        chunksWithoutEmbedding: countSchema,
      },
    },
    embedding: {
      type: 'object',
      required: ['collection', 'provider', 'matches'],
      properties: {
        collection: modelSchema,
        provider: modelSchema,
        matches: { type: 'boolean' },
      },
    },
    search: {
      type: 'object',
      required: ['metric', 'operator', 'iterativeScan', 'efSearch', 'topK', 'minScore'],
      properties: {
        metric: { type: 'string', enum: ['cosine'] },
        operator: { type: 'string', enum: ['<=>'] },
        iterativeScan: { type: 'string', description: '`hnsw.iterative_scan`' },
        efSearch: { type: 'integer', description: '`hnsw.ef_search`' },
        topK: { type: 'integer' },
        minScore: { type: ['number', 'null'] },
      },
    },
    chatContext: {
      type: 'object',
      required: [
        'charBudget',
        'usedChars',
        'includedCount',
        'omittedByBudgetCount',
        'belowMinScoreCount',
      ],
      properties: {
        charBudget: { type: 'integer', description: 'CHAT_CONTEXT_CHAR_BUDGET' },
        usedChars: countSchema,
        includedCount: countSchema,
        omittedByBudgetCount: countSchema,
        belowMinScoreCount: countSchema,
      },
    },
    warnings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['code', 'message'],
        properties: { code: { type: 'string' }, message: { type: 'string' } },
      },
    },
    timings: {
      type: 'object',
      required: ['embeddingMs', 'searchMs'],
      properties: { embeddingMs: { type: 'number' }, searchMs: { type: 'number' } },
    },
    prompt: {
      type: 'object',
      required: ['messages', 'wouldCallModel', 'chatModel'],
      description: 'Only with includePrompt: true. Built without calling the model.',
      properties: {
        messages: {
          type: 'array',
          items: {
            type: 'object',
            required: ['role', 'content'],
            properties: {
              role: { type: 'string', enum: ['system', 'user', 'assistant'] },
              content: { type: 'string' },
            },
          },
        },
        wouldCallModel: { type: 'boolean' },
        noSourcesAnswer: { type: 'string' },
        chatModel: {
          type: 'object',
          required: ['provider', 'model'],
          properties: { provider: { type: 'string' }, model: { type: 'string' } },
        },
      },
    },
  },
} as const;

export const playgroundRoutes: FastifyPluginAsync<PlaygroundRoutesOptions> = async (
  app,
  { playground, maxQueryChars, defaultTopK },
) => {
  app.post<{ Body: PlaygroundSearchRequest; Reply: PlaygroundSearchResponse }>(
    '/playground/search',
    {
      schema: {
        tags: ['playground'],
        summary: 'Retrieval diagnostics: what chat would retrieve and send for a query',
        description: [
          'Runs the same retrieval as `POST /api/retrieval/search` and chat, then adds',
          'diagnostics: per result `includedInChatContext` (exactly the prompt builder’s source',
          'selection within CHAT_CONTEXT_CHAR_BUDGET) and `belowMinScore` (results below',
          '`minScore` are flagged, not dropped), index statistics, embedding model, search',
          'settings, timings and warnings. `includePrompt: true` adds the messages chat would',
          'send – the chat model is never called.',
          '`distance` = pgvector `<=>` (0..2, lower = more similar); `score = 1 - distance`',
          '(-1..1, higher = more similar). Errors as in retrieval: `409 EMBEDDING_MODEL_MISMATCH`,',
          '`503 EMBEDDING_PROVIDER_UNAVAILABLE`, `502 EMBEDDING_PROVIDER_ERROR`.',
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
              description: 'Flag results with `score < minScore` (chat would drop them)',
            },
            includePrompt: {
              type: 'boolean',
              description: 'Return the prompt messages chat would send (no model call)',
            },
          },
        },
        response: {
          200: responseSchema,
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
      const response = await playground.search(request.body, controller.signal);
      // Queries and chunk contents are user data: never at info level (see retrieval routes).
      request.log.info(
        {
          collectionId: response.collectionId,
          topK: response.search.topK,
          minScore: response.search.minScore,
          queryChars: response.query.length,
          results: response.results.length,
          includedInChatContext: response.chatContext.includedCount,
          emptyReason: response.emptyReason,
          warnings: response.warnings.map((warning) => warning.code),
          includePrompt: request.body.includePrompt === true,
          timings: response.timings,
        },
        'playground search',
      );
      request.log.debug(
        { queryPrefix: response.query.slice(0, LOGGED_QUERY_PREFIX_CHARS) },
        'playground search query (truncated)',
      );
      return response;
    },
  );
};
