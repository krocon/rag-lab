import type { FastifyPluginAsync } from 'fastify';
import type { ProvidersStatusResponse } from '@raglab/shared';
import { errorResponseSchema } from '../../http/errors.js';
import type { ProviderStatusService } from '../embeddings/provider-status.service.js';

const embeddingStatusSchema = {
  type: 'object',
  required: ['provider', 'model', 'reachable', 'modelAvailable', 'dimensions', 'verification'],
  properties: {
    provider: { type: 'string' },
    model: { type: 'string' },
    reachable: { type: 'boolean', description: 'The provider answered the availability check' },
    modelAvailable: {
      type: ['boolean', 'null'],
      description: 'The configured model is installed (null: unknown, provider unreachable)',
    },
    dimensions: {
      type: 'object',
      required: ['configured', 'column'],
      properties: {
        configured: { type: 'integer', description: 'EMBEDDING_DIMENSIONS' },
        column: {
          type: ['integer', 'null'],
          description: 'Dimension of chunks.embedding (null if it could not be read)',
        },
        verified: {
          type: 'integer',
          description: 'Vector length of a test embedding; only present with ?verify=true',
        },
      },
    },
    verification: {
      type: 'object',
      required: ['status'],
      properties: {
        status: { type: 'string', enum: ['skipped', 'passed', 'failed'] },
        code: { type: 'string' },
        error: { type: 'string' },
        durationMs: { type: 'integer' },
      },
    },
    error: { type: 'string' },
    hint: { type: 'string' },
  },
} as const;

const chatStatusSchema = {
  type: 'object',
  required: ['provider', 'model', 'reachable', 'modelAvailable'],
  properties: {
    provider: { type: 'string' },
    model: { type: 'string' },
    reachable: { type: 'boolean', description: 'The provider answered the availability check' },
    modelAvailable: {
      type: ['boolean', 'null'],
      description: 'The configured chat model is installed (null: unknown, provider unreachable)',
    },
    error: { type: 'string' },
    hint: { type: 'string' },
  },
} as const;

interface ProvidersQuery {
  verify?: boolean;
}

/**
 * Live provider status. Unlike readiness, an unreachable provider is not an error here (the
 * route always answers 200): collections, documents and the UI stay usable without it.
 */
export const providersRoutes: FastifyPluginAsync<{ providers: ProviderStatusService }> = async (
  app,
  { providers },
) => {
  app.get<{ Querystring: ProvidersQuery; Reply: ProvidersStatusResponse }>(
    '/system/providers',
    {
      schema: {
        tags: ['system'],
        summary: 'Live status of the configured providers (reachability, model, dimensions)',
        description: [
          'Checks whether the embedding provider is reachable and the configured model is installed',
          '(Ollama: `GET /api/tags`) and reports the configured and the database column dimension.',
          'With `?verify=true` it also embeds one short test text and reports the actual vector',
          'length (`dimensions.verified`) – this costs compute time and may load the model.',
          'Nothing is reported as verified unless it was checked. For the chat provider only',
          'reachability and model availability are checked (nothing is generated).',
        ].join(' '),
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { verify: { type: 'boolean', default: false } },
        },
        response: {
          200: {
            type: 'object',
            required: ['embedding', 'chat', 'checkedAt'],
            properties: {
              embedding: embeddingStatusSchema,
              chat: chatStatusSchema,
              checkedAt: { type: 'string', format: 'date-time' },
            },
          },
          400: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const controller = new AbortController();
      // Stop provider requests when the client disconnects before the response is sent.
      reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) {
          controller.abort(new Error('client closed the request'));
        }
      });
      return providers.status({ verify: request.query.verify ?? false, signal: controller.signal });
    },
  );
};
