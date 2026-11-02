import type { FastifyPluginAsync } from 'fastify';
import type { SystemInfoResponse } from '@raglab/shared';
import type { AppConfig } from '../../config/env.js';
import { API_VERSION } from '../../version.js';

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
            required: ['version', 'nodeVersion', 'embedding', 'chat', 'retrieval', 'chunking'],
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
                required: ['defaultTopK'],
                properties: { defaultTopK: { type: 'integer' } },
              },
              chunking: {
                type: 'object',
                required: ['targetSize', 'overlap'],
                properties: { targetSize: { type: 'integer' }, overlap: { type: 'integer' } },
              },
            },
          },
        },
      },
    },
    async () => ({
      version: API_VERSION,
      nodeVersion: process.version,
      embedding: { ...config.embedding },
      chat: { ...config.chat },
      retrieval: { ...config.retrieval },
      chunking: { ...config.chunking },
    }),
  );
};
