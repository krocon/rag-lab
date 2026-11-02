import type { AppConfig } from '../src/config/env.js';
import { loadConfig } from '../src/config/env.js';

export const validEnv = {
  DATABASE_URL: 'postgresql://raglab:raglab@localhost:5432/raglab',
  EMBEDDING_MODEL: 'test-embedding-model',
  EMBEDDING_DIMENSIONS: '768',
  CHAT_MODEL: 'test-chat-model',
} satisfies NodeJS.ProcessEnv;

export function testConfig(overrides: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({ ...validEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent', ...overrides });
}
