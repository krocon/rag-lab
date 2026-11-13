import type { FastifyPluginAsync } from 'fastify';
import type {
  CollectionDto,
  CollectionListResponse,
  CreateCollectionRequest,
  SetCollectionSourceRequest,
  UpdateCollectionRequest,
} from '@raglab/shared';
import { errorResponseSchema } from '../../http/errors.js';
import { idParamsSchema, type IdParams } from '../../http/schemas.js';
import { MAX_SOURCE_REF_LENGTH, MAX_SOURCE_URL_LENGTH } from './collection-source.js';
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
    'source',
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
    source: {
      type: ['object', 'null'],
      required: ['kind', 'url', 'ref', 'commit', 'importedAt'],
      properties: {
        kind: { type: 'string', enum: ['directory', 'git'] },
        url: { type: ['string', 'null'] },
        ref: { type: ['string', 'null'] },
        commit: { type: ['string', 'null'] },
        importedAt: { type: 'string', format: 'date-time' },
      },
    },
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

  app.put<{ Params: IdParams; Body: SetCollectionSourceRequest; Reply: CollectionDto }>(
    '/collections/:id/source',
    {
      schema: {
        tags: ['collections'],
        summary: 'Record where the documents of a collection were imported from',
        description: [
          'Set by `pnpm kb:import` after an import. `url` must not contain credentials',
          '(`400 INVALID_SOURCE`); `commit` is a full hex SHA. With `url` and `commit` of a known host',
          '(GitHub, GitLab, Bitbucket, Codeberg), sources link to the file at that commit.',
          '`importedAt` is set by the server.',
        ].join(' '),
        params: idParamsSchema,
        body: {
          type: 'object',
          required: ['kind'],
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['directory', 'git'] },
            url: { type: ['string', 'null'], maxLength: MAX_SOURCE_URL_LENGTH },
            ref: { type: ['string', 'null'], maxLength: MAX_SOURCE_REF_LENGTH },
            commit: { type: ['string', 'null'], maxLength: 64 },
          },
        },
        response: { 200: collectionSchema, 400: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request) => collections.setSource(request.params.id, request.body),
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
