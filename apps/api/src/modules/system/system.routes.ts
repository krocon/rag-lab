import type { FastifyPluginAsync } from 'fastify';
import type { SystemInfoResponse } from '@raglab/shared';
import type { AppConfig } from '../../config/env.js';
import { API_VERSION } from '../../version.js';
import { SUPPORTED_EXTENSIONS } from '../ingestion/file-type.js';

/** Exposes the non-secret part of the configuration (never URLs with credentials). */
export const systemRoutes: FastifyPluginAsync<{ config: AppConfig }> = async (app, { config }) => {
  app.get<{ Reply: SystemInfoResponse }>(
    '/system/info',
    {
      schema: {
        tags: ['system'],
        summary: 'Configured providers, models and pipeline defaults',
        description:
          'Reports configuration values only. It does not check whether a provider is reachable or a model is installed.',
        response: {
          200: {
            type: 'object',
            required: [
              'version',
              'nodeVersion',
              'embedding',
              'chat',
              'retrieval',
              'chunking',
              'upload',
            ],
            properties: {
              version: { type: 'string' },
              nodeVersion: { type: 'string' },
              embedding: {
                type: 'object',
                required: ['provider', 'model', 'dimensions'],
                properties: {
                  provider: { type: 'string' },
                  model: { type: 'string' },
                  dimensions: { type: 'integer' },
                },
              },
              chat: {
                type: 'object',
                required: ['provider', 'model'],
                properties: { provider: { type: 'string' }, model: { type: 'string' } },
              },
              retrieval: {
                type: 'object',
                required: ['defaultTopK', 'maxQueryChars'],
                properties: {
                  defaultTopK: { type: 'integer' },
                  maxQueryChars: {
                    type: 'integer',
                    description: 'Maximum query length after trimming (MAX_QUERY_CHARS)',
                  },
                },
              },
              chunking: {
                type: 'object',
                required: ['targetSize', 'overlap'],
                properties: { targetSize: { type: 'integer' }, overlap: { type: 'integer' } },
              },
              upload: {
                type: 'object',
                required: [
                  'maxFileBytes',
                  'maxFiles',
                  'maxRequestBytes',
                  'maxDocumentsPerCollection',
                  'allowedExtensions',
                ],
                properties: {
                  maxFileBytes: { type: 'integer' },
                  maxFiles: { type: 'integer' },
                  maxRequestBytes: { type: 'integer' },
                  maxDocumentsPerCollection: { type: ['integer', 'null'] },
                  allowedExtensions: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
    async () => ({
      version: API_VERSION,
      nodeVersion: process.version,
      embedding: {
        provider: config.embedding.provider,
        model: config.embedding.model,
        dimensions: config.embedding.dimensions,
      },
      chat: { provider: config.chat.provider, model: config.chat.model },
      retrieval: {
        defaultTopK: config.retrieval.defaultTopK,
        maxQueryChars: config.retrieval.maxQueryChars,
      },
      chunking: { ...config.chunking },
      upload: { ...config.upload, allowedExtensions: [...SUPPORTED_EXTENSIONS] },
    }),
  );
};
