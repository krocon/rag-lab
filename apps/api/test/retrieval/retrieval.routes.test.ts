import type { ApiErrorResponse, RetrievalSearchResponse } from '@raglab/shared';
import type { FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { EmbeddingProviderError } from '../../src/modules/embeddings/embedding-provider.js';
import { LOGGED_QUERY_PREFIX_CHARS } from '../../src/modules/retrieval/retrieval.routes.js';
import {
  createInMemoryServices,
  createInMemoryStore,
  fakeDocument,
  healthyProbe,
  type InMemoryStore,
} from '../fakes.js';
import {
  createFakeEmbeddingProvider,
  fakeVector,
  type FakeEmbeddingProvider,
} from '../fakes/fake-embedding-provider.js';
import { testConfig } from '../helpers.js';

const UNKNOWN_ID = '0195f2a0-0000-7000-8000-000000000000';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface Started {
  api: FastifyInstance;
  store: InMemoryStore;
  collectionId: string;
  provider: FakeEmbeddingProvider;
}

async function start({
  provider = createFakeEmbeddingProvider(),
  logLines,
}: { provider?: FakeEmbeddingProvider; logLines?: string[] } = {}): Promise<Started> {
  const config = testConfig({ MAX_QUERY_CHARS: '100' });
  const store = createInMemoryStore();
  const services = createInMemoryServices(config, store, { embeddingProvider: provider });
  const loggerInstance = logLines
    ? pino(
        { level: 'debug' },
        new Writable({
          write(chunk: Buffer, _encoding, callback) {
            logLines.push(chunk.toString());
            callback();
          },
        }),
      )
    : undefined;
  app = await buildApp({
    config,
    probe: healthyProbe,
    services,
    ...(loggerInstance ? { loggerInstance } : { logger: false }),
  });
  const collectionId = (await services.collections.create({ name: 'Docs' })).id;
  return { api: app, store, collectionId, provider };
}

/** Stores a ready document whose chunks embed exactly like the given texts. */
function addDocument(store: InMemoryStore, collectionId: string, texts: string[]): string[] {
  const document = fakeDocument({ collectionId, filename: 'notes.md' });
  store.documents.set(document.id, document);
  const chunkIds = texts.map(() => crypto.randomUUID());
  store.chunks.set(
    document.id,
    texts.map((text, index) => ({
      id: chunkIds[index] ?? '',
      documentId: document.id,
      collectionId,
      chunkIndex: index,
      content: text,
      startOffset: 0,
      endOffset: text.length,
      charCount: text.length,
      tokenEstimate: 1,
      headingPath: ['Notes'],
      metadata: {},
      hasEmbedding: true,
      createdAt: new Date(),
    })),
  );
  texts.forEach((text, index) =>
    store.embeddings.set(chunkIds[index] ?? '', fakeVector(text, 768)),
  );
  return chunkIds;
}

function post(api: FastifyInstance, payload: unknown) {
  return api.inject({ method: 'POST', url: '/api/retrieval/search', payload: payload as object });
}

describe('POST /api/retrieval/search', () => {
  it('returns ranked results with distance and score', async () => {
    const { api, store, collectionId } = await start();
    const [match] = addDocument(store, collectionId, ['pgvector stores vectors', 'other text']);

    const response = await post(api, { collectionId, query: 'pgvector stores vectors', topK: 2 });

    expect(response.statusCode).toBe(200);
    const body = response.json<RetrievalSearchResponse>();
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toMatchObject({
      rank: 1,
      chunkId: match,
      filename: 'notes.md',
      chunkIndex: 0,
      headingPath: ['Notes'],
      content: 'pgvector stores vectors',
    });
    expect(body.results[0]?.distance).toBeCloseTo(0, 10);
    expect(body.results[0]?.score).toBeCloseTo(1, 10);
    expect(body.results[1]?.rank).toBe(2);
    expect(body.results[1]?.distance).toBeGreaterThan(body.results[0]?.distance ?? 0);
  });

  it('answers 200 with an empty result and emptyReason for an empty collection', async () => {
    const { api, collectionId } = await start();

    const response = await post(api, { collectionId, query: 'anything' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ results: [], emptyReason: 'collection_empty' });
  });

  it.each([
    ['missing query', { query: undefined }],
    ['empty query', { query: '' }],
    ['blank query', { query: '   ' }],
    ['too long query', { query: 'x'.repeat(101) }],
    ['topK 0', { topK: 0 }],
    ['topK 101', { topK: 101 }],
    ['fractional topK', { topK: 1.5 }],
    ['minScore > 1', { minScore: 1.1 }],
    ['minScore < -1', { minScore: -2 }],
    ['unknown property', { filter: 'x' }],
    ['malformed collection id', { collectionId: 'not-a-uuid' }],
  ])('rejects %s with 400 VALIDATION_ERROR', async (_name, overrides) => {
    const { api, collectionId, provider } = await start();

    const response = await post(api, { collectionId, query: 'q', ...overrides });

    expect(response.statusCode).toBe(400);
    expect(response.json<ApiErrorResponse>().error.code).toBe('VALIDATION_ERROR');
    expect(provider.calls).toEqual([]);
  });

  it('answers 404 COLLECTION_NOT_FOUND for unknown collections', async () => {
    const { api } = await start();
    const response = await post(api, { collectionId: UNKNOWN_ID, query: 'q' });
    expect(response.statusCode).toBe(404);
    expect(response.json<ApiErrorResponse>().error.code).toBe('COLLECTION_NOT_FOUND');
  });

  it('answers 409 EMBEDDING_MODEL_MISMATCH when the provider model changed', async () => {
    const { api, store, collectionId } = await start({
      provider: createFakeEmbeddingProvider({ model: 'new-model' }),
    });
    addDocument(store, collectionId, ['text']);

    const response = await post(api, { collectionId, query: 'q' });

    expect(response.statusCode).toBe(409);
    expect(response.json<ApiErrorResponse>().error).toMatchObject({
      code: 'EMBEDDING_MODEL_MISMATCH',
      details: { collectionModel: 'test-embedding-model', providerModel: 'new-model' },
    });
  });

  it.each([
    ['PROVIDER_UNREACHABLE', 503, 'EMBEDDING_PROVIDER_UNAVAILABLE'],
    ['MODEL_NOT_FOUND', 502, 'EMBEDDING_PROVIDER_ERROR'],
  ] as const)('maps provider failure %s to %i %s', async (providerCode, status, code) => {
    const { api, store, collectionId } = await start({
      provider: createFakeEmbeddingProvider({
        failWith: new EmbeddingProviderError(providerCode, 'Ollama failed.', { hint: 'Hint.' }),
      }),
    });
    addDocument(store, collectionId, ['text']);

    const response = await post(api, { collectionId, query: 'q' });

    expect(response.statusCode).toBe(status);
    expect(response.json<ApiErrorResponse>().error).toEqual({
      code,
      message: 'Ollama failed.',
      details: { providerCode, hint: 'Hint.' },
    });
  });

  it('never logs the query or chunk content at info level, only a short prefix at debug', async () => {
    const logLines: string[] = [];
    const { api, store, collectionId } = await start({ logLines });
    addDocument(store, collectionId, ['CONFIDENTIAL chunk content']);
    const query = `secret-question ${'y'.repeat(60)}`;

    const response = await post(api, { collectionId, query });
    expect(response.statusCode).toBe(200);

    const entries = logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const info = entries.filter((entry) => entry['level'] === 30);
    const debug = entries.filter((entry) => entry['level'] === 20);
    const infoText = JSON.stringify(info);
    expect(infoText).toContain('retrieval search');
    expect(infoText).not.toContain('secret-question');
    expect(infoText).not.toContain('CONFIDENTIAL');
    expect(JSON.stringify(entries)).not.toContain('CONFIDENTIAL');
    const prefix = debug.find((entry) => 'queryPrefix' in entry)?.['queryPrefix'];
    expect(prefix).toBe(query.slice(0, LOGGED_QUERY_PREFIX_CHARS));
    expect(JSON.stringify(debug)).not.toContain(query);
  });

  it('documents the endpoint, distance and score in OpenAPI', async () => {
    const { api } = await start();
    const spec = (await api.inject({ method: 'GET', url: '/api/docs/json' })).json<{
      paths: Record<string, Record<string, unknown>>;
    }>();
    const operation = spec.paths['/api/retrieval/search']?.['post'];
    expect(operation).toBeDefined();
    const text = JSON.stringify(operation);
    expect(text).toContain('Cosine distance as returned by the pgvector operator `<=>`');
    expect(text).toContain('`1 - distance` (cosine similarity)');
    expect(text).toContain('EMBEDDING_MODEL_MISMATCH');
  });
});
