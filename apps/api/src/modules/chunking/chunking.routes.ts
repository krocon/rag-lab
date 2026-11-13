import type { FastifyPluginAsync } from 'fastify';
import type {
  ChunkPreviewRequest,
  ChunkPreviewResponse,
  DocumentChunksResponse,
} from '@raglab/shared';
import { errorResponseSchema } from '../../http/errors.js';
import { idParamsSchema, type IdParams } from '../../http/schemas.js';
import type { ChunkingService } from './chunking.service.js';
import { CHUNKING_FORMATS } from './chunker.js';

/** Maximum input length of the preview (characters); larger texts belong into an upload. */
export const MAX_PREVIEW_TEXT_LENGTH = 100_000;

/** Upper bound for `targetSize` in the preview (the server configuration has its own bounds). */
export const MAX_PREVIEW_TARGET_SIZE = 20_000;

const headingPathSchema = { type: 'array', items: { type: 'string' } } as const;

const chunkSchema = {
  type: 'object',
  required: [
    'id',
    'documentId',
    'collectionId',
    'chunkIndex',
    'content',
    'startOffset',
    'endOffset',
    'charCount',
    'tokenEstimate',
    'headingPath',
    'overlapChars',
    'startLine',
    'endLine',
    'symbol',
    'hasEmbedding',
    'createdAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    documentId: { type: 'string', format: 'uuid' },
    collectionId: { type: 'string', format: 'uuid' },
    chunkIndex: { type: 'integer' },
    content: { type: 'string' },
    startOffset: { type: 'integer', description: 'UTF-16 code units in the normalised text' },
    endOffset: { type: 'integer', description: 'UTF-16 code units in the normalised text' },
    charCount: { type: 'integer' },
    tokenEstimate: { type: ['integer', 'null'], description: '≈ charCount / 4, informative' },
    headingPath: headingPathSchema,
    overlapChars: {
      type: 'integer',
      description: 'Leading characters shared with the previous chunk',
    },
    startLine: { type: ['integer', 'null'], description: '1-based; null for chunks stored before prompt 017' },
    endLine: { type: ['integer', 'null'], description: '1-based; null for chunks stored before prompt 017' },
    symbol: { type: ['string', 'null'], description: 'Enclosing top-level declaration(s) of source code' },
    hasEmbedding: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

const formatSchema = { type: 'string', enum: [...CHUNKING_FORMATS] } as const;

const previewChunkSchema = {
  type: 'object',
  required: [
    'chunkIndex',
    'content',
    'startOffset',
    'endOffset',
    'charCount',
    'tokenEstimate',
    'headingPath',
    'overlapChars',
    'startLine',
    'endLine',
    'symbol',
  ],
  properties: {
    chunkIndex: { type: 'integer' },
    content: { type: 'string' },
    startOffset: { type: 'integer' },
    endOffset: { type: 'integer' },
    charCount: { type: 'integer' },
    tokenEstimate: { type: 'integer' },
    headingPath: headingPathSchema,
    overlapChars: { type: 'integer' },
    startLine: { type: 'integer' },
    endLine: { type: 'integer' },
    symbol: { type: ['string', 'null'] },
  },
} as const;

export interface ChunkingRoutesOptions {
  chunking: ChunkingService;
}

export const chunkingRoutes: FastifyPluginAsync<ChunkingRoutesOptions> = async (
  app,
  { chunking },
) => {
  app.get<{ Params: IdParams; Reply: DocumentChunksResponse }>(
    '/documents/:id/chunks',
    {
      schema: {
        tags: ['chunking'],
        summary: 'List the chunks of a document (without embedding vectors)',
        description: [
          'Ordered by `chunkIndex`; empty while the document is not chunked yet.',
          '`content` equals `content.slice(startOffset, endOffset)` of `GET /api/documents/:id/content`.',
        ].join(' '),
        params: idParamsSchema,
        response: {
          200: {
            type: 'object',
            required: ['documentId', 'chunks'],
            properties: {
              documentId: { type: 'string', format: 'uuid' },
              chunks: { type: 'array', items: chunkSchema },
            },
          },
          400: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request) => chunking.listByDocument(request.params.id),
  );

  app.post<{ Body: ChunkPreviewRequest; Reply: ChunkPreviewResponse }>(
    '/chunking/preview',
    {
      schema: {
        tags: ['chunking'],
        summary: 'Chunk a text without storing it (for experiments and the playground)',
        description: [
          'The text is normalised like an upload; offsets refer to `normalizedText`.',
          '`targetSize` and `overlap` default to `CHUNK_SIZE` and `CHUNK_OVERLAP`;',
          '`overlap` must be smaller than `targetSize` (`400 INVALID_CHUNKING_OPTIONS`).',
        ].join(' '),
        body: {
          type: 'object',
          required: ['text', 'format'],
          additionalProperties: false,
          properties: {
            text: { type: 'string', maxLength: MAX_PREVIEW_TEXT_LENGTH },
            format: formatSchema,
            language: {
              type: 'string',
              maxLength: 32,
              description:
                'For `format: code`: language of the declaration heuristics (e.g. `typescript`, `vue`, `python`)',
            },
            targetSize: { type: 'integer', minimum: 1, maximum: MAX_PREVIEW_TARGET_SIZE },
            overlap: { type: 'integer', minimum: 0, maximum: MAX_PREVIEW_TARGET_SIZE - 1 },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['options', 'normalizedText', 'chunks'],
            properties: {
              options: {
                type: 'object',
                required: ['targetSize', 'overlap', 'format'],
                properties: {
                  targetSize: { type: 'integer' },
                  overlap: { type: 'integer' },
                  format: formatSchema,
                },
              },
              normalizedText: { type: 'string' },
              chunks: { type: 'array', items: previewChunkSchema },
            },
          },
          400: errorResponseSchema,
        },
      },
    },
    async (request) => chunking.preview(request.body),
  );
};
