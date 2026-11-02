import type { ProvidersStatusResponse, ReadinessResponse } from '@raglab/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { EmbeddingProviderError } from '../../src/modules/embeddings/embedding-provider.js';
import { VERIFY_TEXT } from '../../src/modules/embeddings/provider-status.service.js';
import { createInMemoryServices, healthyProbe } from '../fakes.js';
import {
  createFakeEmbeddingProvider,
  modelNotFound,
  type FakeEmbeddingProvider,
} from '../fakes/fake-embedding-provider.js';
import { createFakeChatProvider, type FakeChatProvider } from '../fakes/fake-chat-provider.js';
import { testConfig } from '../helpers.js';

let app: FastifyInstance | undefined;

async function start(
  provider: FakeEmbeddingProvider,
  columnDimensions: () => Promise<number | null> = async () => 768,
  chatProvider: FakeChatProvider = createFakeChatProvider(),
): Promise<FastifyInstance> {
  const config = testConfig();
  app = await buildApp({
    config,
    probe: healthyProbe,
    services: createInMemoryServices(config, undefined, {
      embeddingProvider: provider,
      chatProvider,
      columnDimensions,
    }),
    logger: false,
  });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function getStatus(api: FastifyInstance, query = '') {
  const response = await api.inject({ method: 'GET', url: `/api/system/providers${query}` });
  return { statusCode: response.statusCode, body: response.json<ProvidersStatusResponse>() };
}

describe('GET /api/system/providers', () => {
  it('reports reachability, model and dimensions without a test embedding', async () => {
    const provider = createFakeEmbeddingProvider();
    const api = await start(provider);

    const { statusCode, body } = await getStatus(api);

    expect(statusCode).toBe(200);
    expect(body.embedding).toEqual({
      provider: 'ollama',
      model: 'test-embedding-model',
      reachable: true,
      modelAvailable: true,
      dimensions: { configured: 768, column: 768 },
      verification: { status: 'skipped' },
    });
    expect(body.embedding.dimensions).not.toHaveProperty('verified');
    expect(Date.parse(body.checkedAt)).not.toBeNaN();
    // No compute time spent without ?verify=true.
    expect(provider.calls).toEqual([]);
  });

  it('verifies the output dimension with one test embedding on ?verify=true', async () => {
    const provider = createFakeEmbeddingProvider();
    const api = await start(provider);

    const { body } = await getStatus(api, '?verify=true');

    expect(provider.calls).toEqual([[VERIFY_TEXT]]);
    expect(body.embedding.dimensions).toEqual({ configured: 768, column: 768, verified: 768 });
    expect(body.embedding.verification).toMatchObject({ status: 'passed' });
    expect(body.embedding.verification.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports the observed dimension when the verification finds a mismatch', async () => {
    // As raised by the adapter's response check (assertEmbeddings).
    const mismatch = new EmbeddingProviderError(
      'DIMENSION_MISMATCH',
      'The model returned vectors with 1024 dimensions, but EMBEDDING_DIMENSIONS is 768.',
      { expected: 768, actual: 1024 },
    );
    const api = await start(createFakeEmbeddingProvider({ failWith: mismatch }));

    const { body } = await getStatus(api, '?verify=true');

    expect(body.embedding.dimensions).toEqual({ configured: 768, column: 768, verified: 1024 });
    expect(body.embedding.verification).toMatchObject({
      status: 'failed',
      code: 'DIMENSION_MISMATCH',
    });
  });

  it('reports a failed verification with code and hint', async () => {
    const api = await start(createFakeEmbeddingProvider({ failWith: modelNotFound() }));

    const { body } = await getStatus(api, '?verify=true');

    expect(body.embedding.verification).toMatchObject({
      status: 'failed',
      code: 'MODEL_NOT_FOUND',
      error: expect.stringContaining('ollama pull test-embedding-model'),
    });
    expect(body.embedding.dimensions).not.toHaveProperty('verified');
  });

  it('reports an unreachable provider honestly and still answers 200', async () => {
    const provider = createFakeEmbeddingProvider({
      status: {
        reachable: false,
        modelAvailable: null,
        error: 'Ollama is not reachable.',
        hint: 'Start Ollama.',
      },
    });
    const api = await start(provider);

    const { statusCode, body } = await getStatus(api);

    expect(statusCode).toBe(200);
    expect(body.embedding).toMatchObject({
      reachable: false,
      modelAvailable: null,
      error: 'Ollama is not reachable.',
      hint: 'Start Ollama.',
      verification: { status: 'skipped' },
    });
  });

  it('reports the chat provider without generating anything', async () => {
    const chat = createFakeChatProvider({
      forbidCalls: true,
      status: {
        reachable: true,
        modelAvailable: false,
        error: 'Chat model "test-chat-model" is not installed in Ollama.',
        hint: 'Run "ollama pull test-chat-model" on the Ollama host.',
      },
    });
    const api = await start(createFakeEmbeddingProvider(), undefined, chat);

    const { statusCode, body } = await getStatus(api, '?verify=true');

    expect(statusCode).toBe(200);
    expect(body.chat).toEqual({
      provider: 'ollama',
      model: 'test-chat-model',
      reachable: true,
      modelAvailable: false,
      error: 'Chat model "test-chat-model" is not installed in Ollama.',
      hint: 'Run "ollama pull test-chat-model" on the Ollama host.',
    });
    expect(chat.calls).toEqual([]);
  });

  it('does not change readiness when the provider is unreachable', async () => {
    const api = await start(
      createFakeEmbeddingProvider({ status: { reachable: false, modelAvailable: null } }),
    );

    const response = await api.inject({ method: 'GET', url: '/api/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json<ReadinessResponse>().status).toBe('ready');
  });

  it('reports column null when the database cannot be read', async () => {
    const api = await start(createFakeEmbeddingProvider(), async () => {
      throw new Error('connect ECONNREFUSED');
    });

    const { body } = await getStatus(api);

    expect(body.embedding.dimensions).toEqual({ configured: 768, column: null });
  });

  it('rejects unknown query parameters', async () => {
    const api = await start(createFakeEmbeddingProvider());

    const response = await api.inject({ method: 'GET', url: '/api/system/providers?foo=1' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });
});
