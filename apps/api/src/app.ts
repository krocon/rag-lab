import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { AppConfig } from './config/env.js';
import type { DatabaseProbe } from './db/probe.js';
import { healthRoutes } from './modules/system/health.routes.js';
import { systemRoutes } from './modules/system/system.routes.js';
import { API_VERSION } from './version.js';

export interface AppDependencies {
  config: AppConfig;
  probe: DatabaseProbe;
  logger?: FastifyServerOptions['logger'];
}

/** Builds the Fastify app without listening – used by main.ts and by tests via `app.inject()`. */
export async function buildApp({
  config,
  probe,
  logger,
}: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger ?? { level: config.logLevel },
    // Keep request bodies small until upload handling defines its own limits (prompt 004).
    bodyLimit: 1024 * 1024,
  });

  await app.register(cors, { origin: config.server.corsOrigins });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'RAGLab API',
        description: 'REST API of RAGLab – an open-source RAG workbench for developers.',
        version: API_VERSION,
      },
      tags: [{ name: 'system', description: 'Health and configuration' }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  await app.register(
    async (api) => {
      await api.register(healthRoutes, { probe });
      await api.register(systemRoutes, { config });
    },
    { prefix: '/api' },
  );

  return app;
}
