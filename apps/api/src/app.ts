import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { AppConfig } from './config/env.js';
import type { DatabaseProbe } from './db/probe.js';
import { registerErrorHandling } from './http/error-handler.js';
import { registerSecurity, SWAGGER_UI_CSP } from './http/security.js';
import { loggerOptions } from './logging.js';
import { ActiveStreams, chatRoutes } from './modules/chat/chat.routes.js';
import { chunkingRoutes } from './modules/chunking/chunking.routes.js';
import { collectionsRoutes } from './modules/collections/collections.routes.js';
import { documentsRoutes } from './modules/documents/documents.routes.js';
import { playgroundRoutes } from './modules/playground/playground.routes.js';
import { retrievalRoutes } from './modules/retrieval/retrieval.routes.js';
import { healthRoutes } from './modules/system/health.routes.js';
import { providersRoutes } from './modules/system/providers.routes.js';
import { systemRoutes } from './modules/system/system.routes.js';
import type { AppServices } from './services.js';
import { API_VERSION } from './version.js';

export interface AppDependencies {
  config: AppConfig;
  probe: DatabaseProbe;
  services: AppServices;
  /** Logger options (tests: `false`). Ignored when `loggerInstance` is given. */
  logger?: FastifyServerOptions['logger'];
  /** Existing pino logger shared with background jobs (main.ts). */
  loggerInstance?: FastifyServerOptions['loggerInstance'];
  /** Interval of SSE heartbeat comments in ms (tests: `0` = off). */
  sseHeartbeatMs?: number;
}

/** Builds the Fastify app without listening – used by main.ts and by tests via `app.inject()`. */
export async function buildApp({
  config,
  probe,
  services,
  logger,
  loggerInstance,
  sseHeartbeatMs,
}: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    ...(loggerInstance ? { loggerInstance } : { logger: logger ?? loggerOptions(config) }),
    // Maximum time to receive a whole request (slow uploads, slowloris); responses such as SSE
    // streams are not affected.
    requestTimeout: config.server.requestTimeoutMs,
    // JSON bodies stay small. Uploads are multipart streams with their own limits
    // (MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES), see documents.routes.ts.
    bodyLimit: 1024 * 1024,
    // Reject unknown body properties (`additionalProperties: false` → 400) instead of
    // silently stripping them, which is Fastify's default.
    ajv: { customOptions: { removeAdditional: false } },
  });

  // Open chat streams end before the server waits for in-flight requests (see ActiveStreams).
  const chatStreams = new ActiveStreams();
  app.addHook('preClose', async () => {
    chatStreams.abortAll(new Error('server shutting down'));
  });

  // Running indexing jobs are aborted and awaited before the app (and the DB pool) closes.
  app.addHook('onClose', async () => {
    await services.ingestion.close();
  });

  // Before any route plugin, so every route inherits the uniform error format.
  registerErrorHandling(app);

  // Security headers, CORS, Host/Origin checks, rate limits – before any route (onRoute hooks).
  await registerSecurity(app, config);

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'RAGLab API',
        description: 'REST API of RAGLab – an open-source RAG workbench for developers.',
        version: API_VERSION,
      },
      tags: [
        { name: 'system', description: 'Health and configuration' },
        { name: 'collections', description: 'Knowledge bases' },
        { name: 'documents', description: 'Documents of a knowledge base' },
        { name: 'chunking', description: 'Chunks of documents and chunking preview' },
        { name: 'retrieval', description: 'Vector search (cosine distance, top-K, scores)' },
        { name: 'chat', description: 'Grounded answers with sources (Server-Sent Events)' },
        {
          name: 'playground',
          description: 'Retrieval diagnostics: what chat would retrieve and send (no model call)',
        },
      ],
    },
  });
  if (config.server.docsEnabled) {
    await app.register(swaggerUi, {
      routePrefix: '/api/docs',
      // Replaces the strict API CSP on the Swagger UI routes only.
      staticCSP: SWAGGER_UI_CSP,
      // No request to the public validator service (the plugin's default, made explicit).
      validatorUrl: false,
    });
  }

  await app.register(
    async (api) => {
      await api.register(healthRoutes, { probe });
      await api.register(systemRoutes, { config });
      await api.register(providersRoutes, { providers: services.providers });
      await api.register(collectionsRoutes, { collections: services.collections });
      await api.register(documentsRoutes, {
        documents: services.documents,
        upload: config.upload,
      });
      await api.register(chunkingRoutes, { chunking: services.chunking });
      await api.register(retrievalRoutes, {
        retrieval: services.retrieval,
        maxQueryChars: config.retrieval.maxQueryChars,
        defaultTopK: config.retrieval.defaultTopK,
      });
      await api.register(playgroundRoutes, {
        playground: services.playground,
        maxQueryChars: config.retrieval.maxQueryChars,
        defaultTopK: config.retrieval.defaultTopK,
      });
      await api.register(chatRoutes, {
        chat: services.chat,
        maxQuestionChars: config.chat.maxQuestionChars,
        defaultTopK: config.retrieval.defaultTopK,
        streams: chatStreams,
        maxConcurrentChats: config.security.maxConcurrentChats,
        ...(sseHeartbeatMs !== undefined ? { heartbeatMs: sseHeartbeatMs } : {}),
      });
    },
    { prefix: '/api' },
  );

  return app;
}
