import type {
  ApiErrorResponse,
  ChatSourcesEvent,
  PlaygroundSearchResponse,
  RetrievalSearchResponse,
} from '@raglab/shared';
import type { FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { buildGroundedPrompt } from '../../src/modules/chat/prompt-builder.js';
import { EmbeddingProviderError } from '../../src/modules/embeddings/embedding-provider.js';
import {
  createInMemoryServices,
  createInMemoryStore,
  fakeDocument,
  healthyProbe,
  type InMemoryStore,
} from '../fakes.js';
import { createFakeChatProvider, type FakeChatProvider } from '../fakes/fake-chat-provider.js';
import {
  createFakeEmbeddingProvider,
  fakeVector,
  type FakeEmbeddingProvider,
} from '../fakes/fake-embedding-provider.js';
import { testConfig } from '../helpers.js';
import { parseSse } from '../sse.js';

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
  chat: FakeChatProvider;
}

async function start({
  provider = createFakeEmbeddingProvider(),
  chat = createFakeChatProvider(),
  budget = '1000',
  logLines,
}: {
  provider?: FakeEmbeddingProvider;
  chat?: FakeChatProvider;
  budget?: string;
  logLines?: string[];
} = {}): Promise<Started> {
  const config = testConfig({ MAX_QUERY_CHARS: '100', CHAT_CONTEXT_CHAR_BUDGET: budget });
  const store = createInMemoryStore();
  const services = createInMemoryServices(config, store, {
    embeddingProvider: provider,
    chatProvider: chat,
  });
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
    sseHeartbeatMs: 0,
    ...(loggerInstance ? { loggerInstance } : { logger: false }),
  });
  const collectionId = (await services.collections.create({ name: 'Docs' })).id;
  return { api: app, store, collectionId, provider, chat };
}

/** Stores a document whose chunks embed exactly like the given texts. */
function addDocument(
  store: InMemoryStore,
  collectionId: string,
  texts: string[],
  { status = 'ready', embed = true }: { status?: 'ready' | 'failed'; embed?: boolean } = {},
): string[] {
  const document = fakeDocument({ collectionId, filename: 'notes.md', status });
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
      hasEmbedding: embed,
      createdAt: new Date(),
    })),
  );
  if (embed) {
    texts.forEach((text, index) =>
      store.embeddings.set(chunkIds[index] ?? '', fakeVector(text, 768)),
    );
  }
  return chunkIds;
}

function post(api: FastifyInstance, payload: unknown) {
  return api.inject({ method: 'POST', url: '/api/playground/search', payload: payload as object });
}

/** Ten chunks of ~90 characters: with a budget of 1000 characters, only about six fit. */
const TEXTS = Array.from({ length: 10 }, (_, index) =>
  `${index} ${'pgvector text '.repeat(6)}`.trimEnd(),
);

describe('POST /api/playground/search', () => {
  it('returns the retrieval results with chat flags, stats and diagnostics', async () => {
    const { api, store, collectionId } = await start();
    addDocument(store, collectionId, TEXTS);
    addDocument(store, collectionId, ['not embedded'], { embed: false, status: 'failed' });

    const response = await post(api, {
      collectionId,
      query: TEXTS[0],
      topK: 8,
      minScore: -1,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<PlaygroundSearchResponse>();
    expect(body.results).toHaveLength(8);
    expect(body.results.map((result) => result.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const included = body.results.filter((result) => result.includedInChatContext);
    expect(included.length).toBeGreaterThan(0);
    expect(included.length).toBeLessThan(8);
    expect(body.results.every((result) => !result.belowMinScore)).toBe(true);
    expect(body.chatContext).toMatchObject({
      charBudget: 1000,
      includedCount: included.length,
      omittedByBudgetCount: 8 - included.length,
      belowMinScoreCount: 0,
    });
    expect(body.stats).toEqual({
      documentCount: 2,
      documentsByStatus: { pending: 0, processing: 0, ready: 1, failed: 1 },
      chunkCount: 11,
      searchableChunkCount: 10,
      chunksWithoutEmbedding: 1,
    });
    expect(body.search).toEqual({
      metric: 'cosine',
      operator: '<=>',
      iterativeScan: 'relaxed_order',
      efSearch: 40,
      topK: 8,
      minScore: -1,
    });
    expect(body.embedding.matches).toBe(true);
    expect(body.warnings.map((warning) => warning.code)).toEqual([
      'DOCUMENTS_FAILED',
      'CHUNKS_WITHOUT_EMBEDDING',
    ]);
    expect(body).not.toHaveProperty('prompt');
  });

  it('returns the same chunks, order and scores as the retrieval endpoint', async () => {
    const { api, store, collectionId } = await start();
    addDocument(store, collectionId, TEXTS);
    const payload = { collectionId, query: 'pgvector text', topK: 10 };

    const playground = (await post(api, payload)).json<PlaygroundSearchResponse>();
    const retrieval = (
      await api.inject({ method: 'POST', url: '/api/retrieval/search', payload })
    ).json<RetrievalSearchResponse>();

    expect(
      playground.results.map(({ rank, chunkId, score, distance }) => ({
        rank,
        chunkId,
        score,
        distance,
      })),
    ).toEqual(
      retrieval.results.map(({ rank, chunkId, score, distance }) => ({
        rank,
        chunkId,
        score,
        distance,
      })),
    );
  });

  it.each([undefined, 0.2, 0.99])(
    'flags exactly the chunks chat sends as sources (minScore %s)',
    async (minScore) => {
      const { api, store, collectionId } = await start();
      addDocument(store, collectionId, TEXTS);
      const query = TEXTS[2] ?? '';
      const common = { collectionId, topK: 10, ...(minScore !== undefined ? { minScore } : {}) };

      const playground = (await post(api, { ...common, query })).json<PlaygroundSearchResponse>();
      const chatResponse = await api.inject({
        method: 'POST',
        url: '/api/chat',
        payload: { ...common, question: query },
      });
      const sources = (parseSse(chatResponse.body)[0]?.data as ChatSourcesEvent).sources;

      const included = playground.results.filter((result) => result.includedInChatContext);
      expect(
        included.map(({ chunkId, score, distance, rank }) => ({ chunkId, score, distance, rank })),
      ).toEqual(
        sources.map(({ chunkId, score, distance, n }) => ({ chunkId, score, distance, rank: n })),
      );
      if (minScore === 0.99) {
        // Only the exact match reaches 0.99; the others are flagged, not hidden.
        expect(playground.results.filter((result) => result.belowMinScore)).toHaveLength(9);
      }
    },
  );

  it('returns the prompt chat would send without calling the chat model', async () => {
    const chat = createFakeChatProvider({ forbidCalls: true });
    const { api, store, collectionId } = await start({ chat });
    addDocument(store, collectionId, TEXTS);

    const response = await post(api, {
      collectionId,
      query: ' pgvector text ',
      topK: 10,
      includePrompt: true,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<PlaygroundSearchResponse>();
    const expected = buildGroundedPrompt({
      question: 'pgvector text',
      results: body.results,
      contextCharBudget: 1000,
    });
    expect(body.prompt).toEqual({
      messages: expected.messages,
      wouldCallModel: true,
      chatModel: { provider: 'ollama', model: 'test-chat-model' },
    });
    expect(chat.calls).toEqual([]);
  });

  it('answers 200 with emptyReason and a warning for an empty collection', async () => {
    const { api, collectionId, provider } = await start();

    const response = await post(api, { collectionId, query: 'anything', includePrompt: true });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      results: [],
      emptyReason: 'collection_empty',
      warnings: [{ code: 'COLLECTION_EMPTY' }],
      stats: { documentCount: 0, chunkCount: 0 },
      prompt: { wouldCallModel: false },
    });
    expect(provider.calls).toEqual([]);
  });

  it.each([
    ['missing query', { query: undefined }],
    ['blank query', { query: '   ' }],
    ['too long query', { query: 'x'.repeat(101) }],
    ['topK 0', { topK: 0 }],
    ['topK 101', { topK: 101 }],
    ['minScore > 1', { minScore: 1.1 }],
    ['includePrompt as string', { includePrompt: 'yes' }],
    ['unknown property', { filter: 'x' }],
    ['malformed collection id', { collectionId: 'not-a-uuid' }],
  ])('rejects %s with 400 VALIDATION_ERROR', async (_name, overrides) => {
    const { api, collectionId, provider } = await start();

    const response = await post(api, { collectionId, query: 'q', ...overrides });

    expect(response.statusCode).toBe(400);
    const body = response.json<ApiErrorResponse>();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(typeof body.error.message).toBe('string');
    expect(provider.calls).toEqual([]);
  });

  it('answers 404 COLLECTION_NOT_FOUND for unknown collections', async () => {
    const { api } = await start();
    const response = await post(api, { collectionId: UNKNOWN_ID, query: 'q' });
    expect(response.statusCode).toBe(404);
    expect(response.json<ApiErrorResponse>().error.code).toBe('COLLECTION_NOT_FOUND');
  });

  it('answers 409 EMBEDDING_MODEL_MISMATCH with both models in the details', async () => {
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

  it('answers 503 EMBEDDING_PROVIDER_UNAVAILABLE when the provider is down', async () => {
    const { api, store, collectionId } = await start({
      provider: createFakeEmbeddingProvider({
        failWith: new EmbeddingProviderError('PROVIDER_UNREACHABLE', 'Ollama is down.'),
      }),
    });
    addDocument(store, collectionId, ['text']);

    const response = await post(api, { collectionId, query: 'q' });

    expect(response.statusCode).toBe(503);
    expect(response.json<ApiErrorResponse>().error).toMatchObject({
      code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
      message: 'Ollama is down.',
    });
  });

  it('never logs the query or chunk content at info level', async () => {
    const logLines: string[] = [];
    const { api, store, collectionId } = await start({ logLines });
    addDocument(store, collectionId, ['CONFIDENTIAL chunk content']);

    const response = await post(api, {
      collectionId,
      query: 'secret-question',
      includePrompt: true,
    });
    expect(response.statusCode).toBe(200);

    const entries = logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const info = JSON.stringify(entries.filter((entry) => entry['level'] === 30));
    expect(info).toContain('playground search');
    expect(info).not.toContain('secret-question');
    expect(JSON.stringify(entries)).not.toContain('CONFIDENTIAL');
  });

  it('documents the endpoint with distance, score and the chat flags in OpenAPI', async () => {
    const { api } = await start();
    const spec = (await api.inject({ method: 'GET', url: '/api/docs/json' })).json<{
      paths: Record<string, Record<string, unknown>>;
    }>();
    const text = JSON.stringify(spec.paths['/api/playground/search']?.['post']);
    expect(text).toContain('includedInChatContext');
    expect(text).toContain('belowMinScore');
    expect(text).toContain('`1 - distance` (cosine similarity)');
    expect(text).toContain('the chat model is never called');
  });
});
