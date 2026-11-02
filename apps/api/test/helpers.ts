import type { AppConfig } from '../src/config/env.js';
import { loadConfig } from '../src/config/env.js';
import type { IndexerLogger } from '../src/modules/ingestion/document-indexer.js';

export const validEnv = {
  DATABASE_URL: 'postgresql://raglab:raglab@localhost:5432/raglab',
  EMBEDDING_MODEL: 'test-embedding-model',
  EMBEDDING_DIMENSIONS: '768',
  CHAT_MODEL: 'test-chat-model',
} satisfies NodeJS.ProcessEnv;

export function testConfig(overrides: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({ ...validEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent', ...overrides });
}

/** Logger for tests that do not inspect log output. */
export const silentLogger: IndexerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
