import type {
  ApiErrorResponse,
  ChatDoneEvent,
  ChatSourcesEvent,
  ChatTokenEvent,
} from '@raglab/shared';
import type { FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { ChatProviderError } from '../../src/modules/chat/chat-provider.js';
import { NO_SOURCES_ANSWER, SYSTEM_PROMPT } from '../../src/modules/chat/prompt-builder.js';
import { EmbeddingProviderError } from '../../src/modules/embeddings/embedding-provider.js';
import {
  createInMemoryServices,
  createInMemoryStore,
  fakeDocument,
  healthyProbe,
  type InMemoryStore,
} from '../fakes.js';
import {
  chatModelNotFound,
  createFakeChatProvider,
  type FakeChatProvider,
} from '../fakes/fake-chat-provider.js';
import {
  createFakeEmbeddingProvider,
  fakeVector,
  type FakeEmbeddingProvider,
} from '../fakes/fake-embedding-provider.js';
import { testConfig } from '../helpers.js';
import { parseSse, type ParsedSseEvent } from '../sse.js';

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
  chat: FakeChatProvider;
  embedding: FakeEmbeddingProvider;
}

async function start({
  chat = createFakeChatProvider(),
  embedding = createFakeEmbeddingProvider(),
  env = {},
  logLines,
}: {
  chat?: FakeChatProvider;
  embedding?: FakeEmbeddingProvider;
  env?: NodeJS.ProcessEnv;
  logLines?: string[];
} = {}): Promise<Started> {
  const config = testConfig({ MAX_QUESTION_CHARS: '100', ...env });
  const store = createInMemoryStore();
  const services = createInMemoryServices(config, store, {
    embeddingProvider: embedding,
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
  return { api: app, store, collectionId, chat, embedding };
}

/** Stores a ready document whose chunks embed exactly like the given texts. */
function addDocument(
  store: InMemoryStore,
  collectionId: string,
  texts: string[],
  filename = 'notes.md',
): { documentId: string; chunkIds: string[] } {
  const document = fakeDocument({ collectionId, filename });
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
  return { documentId: document.id, chunkIds };
}

function post(api: FastifyInstance, payload: unknown, headers: Record<string, string> = {}) {
  return api.inject({ method: 'POST', url: '/api/chat', payload: payload as object, headers });
}

const names = (events: ParsedSseEvent[]) => events.map((event) => event.event);
const dataOf = <T>(events: ParsedSseEvent[], name: string) =>
  events.find((event) => event.event === name)?.data as T;

describe('POST /api/chat', () => {
  it('streams sources, tokens and done in this order', async () => {
    const { api, store, collectionId, chat } = await start({
      chat: createFakeChatProvider({ tokens: ['pgvector ', 'stores vectors ', '[1].'] }),
    });
    const { documentId, chunkIds } = addDocument(store, collectionId, [
      'pgvector stores vectors',
      'something else',
    ]);

    const response = await post(api, {
      collectionId,
      question: 'pgvector stores vectors',
      topK: 2,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-cache, no-transform');
    const events = parseSse(response.body);
    expect(names(events)).toEqual(['sources', 'token', 'token', 'token', 'done']);

    const { sources } = dataOf<ChatSourcesEvent>(events, 'sources');
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({
      n: 1,
      documentId,
      chunkId: chunkIds[0],
      chunkIndex: 0,
      filename: 'notes.md',
      headingPath: ['Notes'],
      content: 'pgvector stores vectors',
    });
    expect(sources[0]?.score).toBeCloseTo(1, 10);
    expect(sources[0]?.distance).toBeCloseTo(0, 10);
    expect(sources[1]).toMatchObject({ n: 2, chunkId: chunkIds[1] });

    const tokens = events
      .filter((event) => event.event === 'token')
      .map((event) => (event.data as ChatTokenEvent).text);
    expect(tokens.join('')).toBe('pgvector stores vectors [1].');

    const done = dataOf<ChatDoneEvent>(events, 'done');
    expect(done).toMatchObject({
      answerStatus: 'answered',
      citedSources: [1],
      unknownCitations: [],
      model: 'test-chat-model',
    });
    expect(done.timings.firstTokenMs).not.toBeNull();
    expect(done.timings.totalMs).toBeGreaterThanOrEqual(done.timings.generationMs);

    // The model got the system rules and exactly the delivered sources.
    expect(chat.calls).toHaveLength(1);
    const [system, user] = chat.calls[0]?.messages ?? [];
    expect(system).toEqual({ role: 'system', content: SYSTEM_PROMPT });
    expect(user?.content).toContain('<source id="1" document="notes.md" chunk="0"');
    expect(user?.content).toContain('<source id="2" document="notes.md" chunk="1"');
    expect(user?.content).toContain('Question:\npgvector stores vectors');
  });

  it('reports citations without a delivered source as unknownCitations', async () => {
    const { api, store, collectionId } = await start({
      chat: createFakeChatProvider({ tokens: ['A [1]', ', B [2, 5]', ' and C [0].'] }),
    });
    addDocument(store, collectionId, ['alpha', 'beta']);

    const events = parseSse((await post(api, { collectionId, question: 'alpha' })).body);

    expect(dataOf<ChatDoneEvent>(events, 'done')).toMatchObject({
      citedSources: [1, 2],
      unknownCitations: [0, 5],
    });
  });

  it('answers without calling the model when nothing was found (no_sources)', async () => {
    const chat = createFakeChatProvider({ forbidCalls: true });
    const { api, collectionId } = await start({ chat });

    const response = await post(api, { collectionId, question: 'anything' });

    expect(response.statusCode).toBe(200);
    const events = parseSse(response.body);
    expect(events).toEqual([
      { event: 'sources', data: { sources: [] } },
      { event: 'token', data: { text: NO_SOURCES_ANSWER } },
      {
        event: 'done',
        data: {
          answerStatus: 'no_sources',
          citedSources: [],
          unknownCitations: [],
          model: null,
          timings: expect.objectContaining({ firstTokenMs: null, generationMs: 0 }) as unknown,
        },
      },
    ]);
    expect(chat.calls).toEqual([]);
  });

  it('treats results below minScore as no sources', async () => {
    const chat = createFakeChatProvider({ forbidCalls: true });
    const { api, store, collectionId } = await start({ chat });
    addDocument(store, collectionId, ['completely unrelated text']);

    const events = parseSse(
      (await post(api, { collectionId, question: 'pgvector', minScore: 0.99 })).body,
    );

    expect(dataOf<ChatDoneEvent>(events, 'done').answerStatus).toBe('no_sources');
  });

  it('sends only sources that fit into the context budget', async () => {
    const { api, store, collectionId, chat } = await start({
      env: { CHAT_CONTEXT_CHAR_BUDGET: '1000' },
    });
    addDocument(store, collectionId, ['short answer text', 'x'.repeat(900), 'tail chunk']);

    const events = parseSse(
      (await post(api, { collectionId, question: 'short answer text' })).body,
    );

    const { sources } = dataOf<ChatSourcesEvent>(events, 'sources');
    const sent = chat.calls[0]?.messages[1]?.content ?? '';
    expect(sources.length).toBeGreaterThanOrEqual(1);
    expect(sources.length).toBeLessThan(3);
    // Exactly the sources of the event were in the prompt – nothing else.
    expect(sent.match(/<source id=/g)).toHaveLength(sources.length);
    for (const source of sources) {
      expect(sent).toContain(`<source id="${source.n}"`);
    }
    expect(sent).not.toContain('x'.repeat(900));
  });

  it('turns a provider failure in the middle of the stream into an error event', async () => {
    const { api, store, collectionId } = await start({
      chat: createFakeChatProvider({
        tokens: ['partial ', 'answer'],
        failAfter: 1,
        failWith: new ChatProviderError('PROVIDER_ERROR', 'Ollama reported an error: boom'),
      }),
    });
    addDocument(store, collectionId, ['text']);

    const response = await post(api, { collectionId, question: 'text' });

    expect(response.statusCode).toBe(200);
    const events = parseSse(response.body);
    expect(names(events)).toEqual(['sources', 'token', 'error']);
    expect(dataOf(events, 'error')).toEqual({
      code: 'CHAT_PROVIDER_ERROR',
      message: 'Ollama reported an error: boom',
    });
  });

  it.each([
    [chatModelNotFound(), 'CHAT_PROVIDER_ERROR', 'ollama pull test-chat-model'],
    [
      new ChatProviderError('PROVIDER_UNREACHABLE', 'Ollama is not reachable.', {
        hint: 'Start it.',
      }),
      'CHAT_PROVIDER_UNAVAILABLE',
      'Ollama is not reachable. Start it.',
    ],
    [
      new ChatProviderError('PROVIDER_TIMEOUT', 'Ollama did not answer.'),
      'CHAT_PROVIDER_UNAVAILABLE',
      'Ollama did not answer.',
    ],
  ])('maps %s before the first token to an error event', async (failWith, code, message) => {
    const { api, store, collectionId } = await start({
      chat: createFakeChatProvider({ failWith }),
    });
    addDocument(store, collectionId, ['text']);

    const events = parseSse((await post(api, { collectionId, question: 'text' })).body);

    expect(names(events)).toEqual(['sources', 'error']);
    const error = dataOf<{ code: string; message: string }>(events, 'error');
    expect(error.code).toBe(code);
    expect(error.message).toContain(message);
  });

  it('reports unexpected errors as INTERNAL_ERROR without details', async () => {
    const { api, store, collectionId } = await start({
      chat: createFakeChatProvider({ failWith: new Error('secret internal detail') }),
    });
    addDocument(store, collectionId, ['text']);

    const events = parseSse((await post(api, { collectionId, question: 'text' })).body);

    expect(dataOf(events, 'error')).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'The answer could not be generated. See the server log for details.',
    });
    expect(JSON.stringify(events)).not.toContain('secret');
  });

  it.each([
    ['missing question', { question: undefined }],
    ['empty question', { question: '' }],
    ['blank question', { question: '   ' }],
    ['too long question', { question: 'x'.repeat(101) }],
    ['topK 0', { topK: 0 }],
    ['topK 101', { topK: 101 }],
    ['minScore > 1', { minScore: 1.5 }],
    ['unknown property', { history: [] }],
    ['malformed collection id', { collectionId: 'nope' }],
  ])('rejects %s with JSON 400 VALIDATION_ERROR before streaming', async (_name, overrides) => {
    const chat = createFakeChatProvider({ forbidCalls: true });
    const { api, collectionId, embedding } = await start({ chat });

    const response = await post(api, { collectionId, question: 'q', ...overrides });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json<ApiErrorResponse>().error.code).toBe('VALIDATION_ERROR');
    expect(embedding.calls).toEqual([]);
  });

  it('answers JSON 404 COLLECTION_NOT_FOUND for unknown collections', async () => {
    const { api } = await start({ chat: createFakeChatProvider({ forbidCalls: true }) });
    const response = await post(api, { collectionId: UNKNOWN_ID, question: 'q' });
    expect(response.statusCode).toBe(404);
    expect(response.json<ApiErrorResponse>().error.code).toBe('COLLECTION_NOT_FOUND');
  });

  it('answers JSON 409 EMBEDDING_MODEL_MISMATCH before streaming', async () => {
    const { api, store, collectionId } = await start({
      embedding: createFakeEmbeddingProvider({ model: 'other-model' }),
      chat: createFakeChatProvider({ forbidCalls: true }),
    });
    addDocument(store, collectionId, ['text']);

    const response = await post(api, { collectionId, question: 'q' });

    expect(response.statusCode).toBe(409);
    expect(response.json<ApiErrorResponse>().error.code).toBe('EMBEDDING_MODEL_MISMATCH');
  });

  it('answers JSON 503 when the embedding provider is unreachable', async () => {
    const { api, store, collectionId } = await start({
      embedding: createFakeEmbeddingProvider({
        failWith: new EmbeddingProviderError('PROVIDER_UNREACHABLE', 'Ollama is not reachable.'),
      }),
      chat: createFakeChatProvider({ forbidCalls: true }),
    });
    addDocument(store, collectionId, ['text']);

    const response = await post(api, { collectionId, question: 'q' });

    expect(response.statusCode).toBe(503);
    expect(response.json<ApiErrorResponse>().error.code).toBe('EMBEDDING_PROVIDER_UNAVAILABLE');
  });

  it('keeps CORS headers on the hijacked stream', async () => {
    const { api, collectionId } = await start();

    const response = await post(
      api,
      { collectionId, question: 'q' },
      { origin: 'http://localhost:4200' },
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:4200');
  });

  it('never logs the question, sources or answer', async () => {
    const logLines: string[] = [];
    const { api, store, collectionId } = await start({
      logLines,
      chat: createFakeChatProvider({
        tokens: ['CONFIDENTIAL-ANSWER '],
        failAfter: 1,
        failWith: new ChatProviderError('PROVIDER_ERROR', 'Ollama reported an error: boom'),
      }),
    });
    addDocument(store, collectionId, ['CONFIDENTIAL-CHUNK text']);

    await post(api, { collectionId, question: 'CONFIDENTIAL-QUESTION text' });

    const logs = logLines.join('\n');
    expect(logs).not.toContain('CONFIDENTIAL');
    const summary = logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry['msg'] === 'chat answer');
    expect(summary).toMatchObject({
      collectionId,
      questionChars: 'CONFIDENTIAL-QUESTION text'.length,
      sources: 1,
      errorCode: 'CHAT_PROVIDER_ERROR',
    });
    expect(logs).toContain('chat provider failed');
  });

  it('documents the endpoint and the SSE events in OpenAPI', async () => {
    const { api } = await start();
    const spec = (await api.inject({ method: 'GET', url: '/api/docs/json' })).json<{
      paths: Record<string, Record<string, unknown>>;
    }>();
    const operation = JSON.stringify(spec.paths['/api/chat']?.['post']);
    expect(operation).toContain('text/event-stream');
    expect(operation).toContain('unknownCitations');
    expect(operation).toContain('prompt injection');
  });
});
