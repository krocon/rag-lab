import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, MAX_UPLOAD_BYTES_LIMIT } from '../src/config/env.js';
import { validEnv } from './helpers.js';

describe('loadConfig', () => {
  it('applies defaults for optional values', () => {
    const config = loadConfig(validEnv);

    expect(config.server).toEqual({
      host: '127.0.0.1',
      port: 3000,
      corsOrigins: ['http://localhost:4200'],
      allowedHosts: ['localhost', '127.0.0.1', '[::1]'],
      networkAccessProtected: false,
      docsEnabled: true,
      requestTimeoutMs: 120_000,
    });
    expect(config.security).toEqual({
      rateLimit: {
        enabled: true,
        windowMs: 60_000,
        max: 300,
        uploadMax: 30,
        chatMax: 20,
        searchMax: 60,
      },
      maxConcurrentChats: 4,
    });
    expect(config.embedding).toEqual({
      provider: 'ollama',
      model: 'test-embedding-model',
      dimensions: 768,
      batchSize: 32,
      timeoutMs: 60_000,
    });
    expect(config.retrieval).toEqual({ defaultTopK: 8, maxQueryChars: 2000 });
    expect(config.chunking).toEqual({ targetSize: 1200, overlap: 200 });
    expect(config.chat).toEqual({
      provider: 'ollama',
      model: 'test-chat-model',
      timeoutMs: 120_000,
      contextCharBudget: 12_000,
      maxQuestionChars: 2000,
    });
  });

  it('reads and validates the chat settings', () => {
    expect(
      loadConfig({
        ...validEnv,
        CHAT_TIMEOUT_MS: '5000',
        CHAT_CONTEXT_CHAR_BUDGET: '4000',
        MAX_QUESTION_CHARS: '500',
      }).chat,
    ).toMatchObject({ timeoutMs: 5000, contextCharBudget: 4000, maxQuestionChars: 500 });
    expect(() => loadConfig({ ...validEnv, CHAT_TIMEOUT_MS: '999' })).toThrowError(
      /CHAT_TIMEOUT_MS/,
    );
    expect(() => loadConfig({ ...validEnv, CHAT_CONTEXT_CHAR_BUDGET: '999' })).toThrowError(
      /CHAT_CONTEXT_CHAR_BUDGET/,
    );
    expect(() => loadConfig({ ...validEnv, CHAT_CONTEXT_CHAR_BUDGET: '200001' })).toThrowError(
      /CHAT_CONTEXT_CHAR_BUDGET/,
    );
  });

  it('keeps MAX_QUESTION_CHARS within MAX_QUERY_CHARS (the question is the search query)', () => {
    expect(loadConfig({ ...validEnv, MAX_QUERY_CHARS: '300' }).chat.maxQuestionChars).toBe(300);
    expect(() =>
      loadConfig({ ...validEnv, MAX_QUERY_CHARS: '300', MAX_QUESTION_CHARS: '301' }),
    ).toThrowError(/MAX_QUESTION_CHARS must not be larger than MAX_QUERY_CHARS/);
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

  it('reads and validates the retrieval limits', () => {
    expect(
      loadConfig({ ...validEnv, RETRIEVAL_TOP_K: '100', MAX_QUERY_CHARS: '500' }).retrieval,
    ).toEqual({ defaultTopK: 100, maxQueryChars: 500 });
    expect(() => loadConfig({ ...validEnv, RETRIEVAL_TOP_K: '101' })).toThrowError(
      /RETRIEVAL_TOP_K/,
    );
    expect(() => loadConfig({ ...validEnv, MAX_QUERY_CHARS: '0' })).toThrowError(/MAX_QUERY_CHARS/);
    expect(() => loadConfig({ ...validEnv, MAX_QUERY_CHARS: '20001' })).toThrowError(
      /MAX_QUERY_CHARS/,
    );
  });

  it('reads and validates the embedding batch size and timeout', () => {
    const config = loadConfig({
      ...validEnv,
      EMBEDDING_BATCH_SIZE: '8',
      EMBEDDING_TIMEOUT_MS: '5000',
    });
    expect(config.embedding).toMatchObject({ batchSize: 8, timeoutMs: 5000 });

    expect(() => loadConfig({ ...validEnv, EMBEDDING_BATCH_SIZE: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...validEnv, EMBEDDING_BATCH_SIZE: '513' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...validEnv, EMBEDDING_TIMEOUT_MS: '999' })).toThrow(ConfigError);
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

  it('applies upload and ingestion defaults', () => {
    const config = loadConfig(validEnv);

    expect(config.upload).toEqual({
      maxRequestBytes: 100 * 1024 * 1024,
      maxDocumentsPerCollection: null,
      maxFileBytes: 5 * 1024 * 1024,
      maxFiles: 20,
    });
    expect(config.ingestion).toEqual({ concurrency: 2 });
  });

  it('caps upload limits and concurrency', () => {
    expect(() =>
      loadConfig({ ...validEnv, MAX_UPLOAD_BYTES: String(MAX_UPLOAD_BYTES_LIMIT + 1) }),
    ).toThrowError(/MAX_UPLOAD_BYTES/);
    expect(() => loadConfig({ ...validEnv, MAX_UPLOAD_FILES: '0' })).toThrowError(
      /MAX_UPLOAD_FILES/,
    );
    expect(() => loadConfig({ ...validEnv, INGESTION_CONCURRENCY: '17' })).toThrowError(
      /INGESTION_CONCURRENCY/,
    );
  });

  it('reads the security settings', () => {
    const config = loadConfig({
      ...validEnv,
      ALLOWED_HOSTS: 'raglab.example.com, LOCALHOST',
      NETWORK_ACCESS_PROTECTED: 'true',
      API_DOCS_ENABLED: 'false',
      REQUEST_TIMEOUT_MS: '30000',
      RATE_LIMIT_ENABLED: 'no',
      RATE_LIMIT_WINDOW_MS: '1000',
      RATE_LIMIT_MAX: '5',
      RATE_LIMIT_UPLOAD_MAX: '1',
      RATE_LIMIT_CHAT_MAX: '2',
      RATE_LIMIT_SEARCH_MAX: '3',
      MAX_CONCURRENT_CHATS: '1',
      MAX_UPLOAD_REQUEST_BYTES: String(10 * 1024 * 1024),
      MAX_DOCUMENTS_PER_COLLECTION: '50',
    });

    expect(config.server).toMatchObject({
      allowedHosts: ['raglab.example.com', 'localhost'],
      networkAccessProtected: true,
      docsEnabled: false,
      requestTimeoutMs: 30_000,
    });
    expect(config.security).toEqual({
      rateLimit: {
        enabled: false,
        windowMs: 1000,
        max: 5,
        uploadMax: 1,
        chatMax: 2,
        searchMax: 3,
      },
      maxConcurrentChats: 1,
    });
    expect(config.upload).toMatchObject({
      maxRequestBytes: 10 * 1024 * 1024,
      maxDocumentsPerCollection: 50,
    });
    expect(loadConfig({ ...validEnv, ALLOWED_HOSTS: '*' }).server.allowedHosts).toBeNull();
  });

  it('rejects wildcard and malformed CORS origins', () => {
    for (const value of ['*', 'http://localhost:4200/', 'localhost:4200', 'http://a.test/path']) {
      expect(() => loadConfig({ ...validEnv, CORS_ORIGINS: value })).toThrowError(/CORS_ORIGINS/);
    }
    expect(
      loadConfig({ ...validEnv, CORS_ORIGINS: 'http://localhost:4200, https://raglab.example.com' })
        .server.corsOrigins,
    ).toEqual(['http://localhost:4200', 'https://raglab.example.com']);
  });

  it('rejects invalid boolean flags and inconsistent upload limits', () => {
    expect(() => loadConfig({ ...validEnv, RATE_LIMIT_ENABLED: 'maybe' })).toThrowError(
      /RATE_LIMIT_ENABLED/,
    );
    expect(() =>
      loadConfig({ ...validEnv, MAX_UPLOAD_BYTES: '2048', MAX_UPLOAD_REQUEST_BYTES: '1024' }),
    ).toThrowError(/MAX_UPLOAD_REQUEST_BYTES/);
    expect(() => loadConfig({ ...validEnv, MAX_CONCURRENT_CHATS: '0' })).toThrowError(
      /MAX_CONCURRENT_CHATS/,
    );
  });
});
