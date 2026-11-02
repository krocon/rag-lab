import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/env.js';
import { validEnv } from './helpers.js';

describe('loadConfig', () => {
  it('applies defaults for optional values', () => {
    const config = loadConfig(validEnv);

    expect(config.server).toEqual({
      host: '127.0.0.1',
      port: 3000,
      corsOrigins: ['http://localhost:4200'],
    });
    expect(config.embedding).toEqual({
      provider: 'ollama',
      model: 'test-embedding-model',
      dimensions: 768,
    });
    expect(config.retrieval.defaultTopK).toBe(8);
    expect(config.chunking).toEqual({ targetSize: 1200, overlap: 200 });
  });

  it('coerces numeric strings and splits CORS origins', () => {
    const config = loadConfig({
      ...validEnv,
      API_PORT: '8080',
      CORS_ORIGINS: 'http://a.test, http://b.test ,',
    });

    expect(config.server.port).toBe(8080);
    expect(config.server.corsOrigins).toEqual(['http://a.test', 'http://b.test']);
  });

  it('treats empty strings as unset', () => {
    expect(loadConfig({ ...validEnv, API_PORT: '' }).server.port).toBe(3000);
  });

  it('reports every missing required variable at once', () => {
    expect(() => loadConfig({})).toThrowError(ConfigError);
    try {
      loadConfig({});
    } catch (error) {
      const issues = (error as ConfigError).issues.join('\n');
      expect(issues).toContain('DATABASE_URL');
      expect(issues).toContain('EMBEDDING_MODEL');
      expect(issues).toContain('EMBEDDING_DIMENSIONS');
      expect(issues).toContain('CHAT_MODEL');
    }
  });

  it('rejects non-postgres database URLs', () => {
    expect(() => loadConfig({ ...validEnv, DATABASE_URL: 'mysql://localhost/db' })).toThrowError(
      /postgres/,
    );
  });

  it('rejects embedding dimensions above the pgvector HNSW limit', () => {
    expect(() => loadConfig({ ...validEnv, EMBEDDING_DIMENSIONS: '3072' })).toThrowError(
      /EMBEDDING_DIMENSIONS/,
    );
  });

  it('rejects an overlap that is not smaller than the chunk size', () => {
    expect(() => loadConfig({ ...validEnv, CHUNK_SIZE: '500', CHUNK_OVERLAP: '500' })).toThrowError(
      /CHUNK_OVERLAP/,
    );
  });

  it('rejects unsupported providers', () => {
    expect(() => loadConfig({ ...validEnv, EMBEDDING_PROVIDER: 'unknown' })).toThrowError(
      /EMBEDDING_PROVIDER/,
    );
  });
});
