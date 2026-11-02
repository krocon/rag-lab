import type { FastifyPluginAsync } from 'fastify';
import type {
  CollectionDto,
  CollectionListResponse,
  CreateCollectionRequest,
  UpdateCollectionRequest,
} from '@raglab/shared';
import { errorResponseSchema } from '../../http/errors.js';
import { idParamsSchema, type IdParams } from '../../http/schemas.js';
import type { CollectionsService } from './collections.service.js';

const NAME_MAX_LENGTH = 120;
const DESCRIPTION_MAX_LENGTH = 2000;

export const collectionSchema = {
  type: 'object',
  required: [
    'id',
    'name',
    'description',
    'embeddingProvider',
    'embeddingModel',
    'embeddingDimensions',
    'documentCount',
    'readyDocumentCount',
    'chunkCount',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    description: { type: ['string', 'null'] },
    embeddingProvider: { type: 'string' },
    embeddingModel: { type: 'string' },
    embeddingDimensions: { type: 'integer' },
    documentCount: { type: 'integer' },
    readyDocumentCount: { type: 'integer' },
    chunkCount: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const nameSchema = {
  type: 'string',
  minLength: 1,
  maxLength: NAME_MAX_LENGTH,
  // At least one non-whitespace character; leading/trailing whitespace is trimmed.
  pattern: '\\S',
  description: 'Unique (case-insensitive), 1–120 characters',
} as const;

export const collectionsRoutes: FastifyPluginAsync<{ collections: CollectionsService }> = async (
  app,
  { collections },
) => {
  app.get<{ Reply: CollectionListResponse }>(
    '/collections',
    {
      schema: {
        tags: ['collections'],
        summary: 'List all collections with document and chunk counts',
        description: 'Returns the complete list (no pagination in the MVP), oldest first.',
        response: {
          200: {
            type: 'object',
            required: ['items'],
            properties: { items: { type: 'array', items: collectionSchema } },
          },
        },
      },
    },
    async () => ({ items: await collections.list() }),
  );

  app.post<{ Body: CreateCollectionRequest; Reply: CollectionDto }>(
    '/collections',
    {
      schema: {
        tags: ['collections'],
        summary: 'Create a collection',
        description:
          'Embedding provider, model and dimensions are taken from the server configuration and cannot be changed later.',
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: nameSchema,
            description: { type: 'string', maxLength: DESCRIPTION_MAX_LENGTH },
          },
        },
        response: {
          201: collectionSchema,
          400: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => reply.code(201).send(await collections.create(request.body)),
  );

  app.get<{ Params: IdParams; Reply: CollectionDto }>(
    '/collections/:id',
    {
      schema: {
        tags: ['collections'],
        summary: 'Get a collection',
        params: idParamsSchema,
        response: { 200: collectionSchema, 400: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request) => collections.get(request.params.id),
  );

  app.patch<{ Params: IdParams; Body: UpdateCollectionRequest; Reply: CollectionDto }>(
    '/collections/:id',
    {
      schema: {
        tags: ['collections'],
        summary: 'Rename a collection or change its description',
        description:
          'Embedding settings are immutable. `description: null` (or an empty string) clears the description.',
        params: idParamsSchema,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: nameSchema,
            description: { type: ['string', 'null'], maxLength: DESCRIPTION_MAX_LENGTH },
          },
        },
        response: {
          200: collectionSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request) => collections.update(request.params.id, request.body),
  );

  app.delete<{ Params: IdParams }>(
    '/collections/:id',
    {
      schema: {
        tags: ['collections'],
        summary: 'Delete a collection including all its documents and chunks',
        params: idParamsSchema,
        response: {
          204: { type: 'null', description: 'Deleted' },
          400: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await collections.delete(request.params.id);
      return reply.code(204).send();
    },
  );
};
