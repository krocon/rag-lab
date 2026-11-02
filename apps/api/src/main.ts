import { pino } from 'pino';
import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config/env.js';
import { loadEnvFile } from './config/load-env-file.js';
import { createDatabase } from './db/client.js';
import { createPgProbe } from './db/probe.js';
import { securityWarnings } from './http/security.js';
import { loggerOptions } from './logging.js';
import { createServices } from './services.js';

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  // One logger for HTTP requests and background indexing jobs.
  // Redacts credentials (headers, DATABASE_URL, keys) should they ever reach a log call.
  const logger = pino(loggerOptions(config));
  const database = createDatabase(config.database.url, config.database.poolMax);
  const services = createServices(database.db, config, logger.child({ module: 'ingestion' }));
  const app = await buildApp({
    config,
    probe: createPgProbe(database.pool, { embeddingDimensions: config.embedding.dimensions }),
    services,
    loggerInstance: logger,
  });

  // onClose hooks run in reverse registration order, so this one runs before buildApp's own
  // indexer hook: stop the indexer explicitly (idempotent) before closing the pool.
  app.addHook('onClose', async () => {
    await services.ingestion.close();
    await database.close();
  });

  // Nothing may stay `processing` after a restart (docs/architecture.md §4.1).
  await services.ingestion.recover();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'shutting down');
      void app.close().then(() => process.exit(0));
    });
  }

  await app.listen({ host: config.server.host, port: config.server.port });
  // Only non-secret settings: never config.database (DATABASE_URL contains the password).
  app.log.info(
    {
      embedding: config.embedding,
      chat: config.chat,
      docs: config.server.docsEnabled
        ? `http://${config.server.host}:${config.server.port}/api/docs`
        : 'disabled (API_DOCS_ENABLED=false)',
    },
    'RAGLab API started',
  );
  for (const warning of securityWarnings(config)) {
    app.log.warn(warning);
  }

  // Informational only: an unavailable provider does not make the API unready (documents then
  // fail with a clear message and can be reindexed later).
  const { embedding, chat } = await services.providers.status();
  if (!embedding.reachable || embedding.modelAvailable !== true) {
    app.log.warn(
      {
        provider: embedding.provider,
        model: embedding.model,
        reachable: embedding.reachable,
        modelAvailable: embedding.modelAvailable,
        hint: embedding.hint,
      },
      `embedding provider not usable: ${embedding.error ?? 'unknown problem'}`,
    );
  }
  if (!chat.reachable || chat.modelAvailable !== true) {
    app.log.warn(
      {
        provider: chat.provider,
        model: chat.model,
        reachable: chat.reachable,
        modelAvailable: chat.modelAvailable,
        hint: chat.hint,
      },
      `chat provider not usable: ${chat.error ?? 'unknown problem'}`,
    );
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error('Failed to start RAGLab API:', error);
  }
  process.exit(1);
});
