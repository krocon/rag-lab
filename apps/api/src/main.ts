import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config/env.js';
import { loadEnvFile } from './config/load-env-file.js';
import { createDatabase } from './db/client.js';
import { createPgProbe } from './db/probe.js';

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const database = createDatabase(config.database.url, config.database.poolMax);
  const app = await buildApp({ config, probe: createPgProbe(database.pool) });

  app.addHook('onClose', async () => {
    await database.close();
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'shutting down');
      void app.close().then(() => process.exit(0));
    });
  }

  await app.listen({ host: config.server.host, port: config.server.port });
  app.log.info(
    {
      embedding: config.embedding,
      chat: config.chat,
      docs: `http://${config.server.host}:${config.server.port}/api/docs`,
    },
    'RAGLab API started',
  );
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error('Failed to start RAGLab API:', error);
  }
  process.exit(1);
});
