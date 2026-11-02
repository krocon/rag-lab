import { readFile } from 'node:fs/promises';
import type {
  ChatDoneEvent,
  ChatSourcesEvent,
  CollectionDto,
  DocumentDto,
  DocumentListResponse,
  PlaygroundSearchResponse,
  RetrievalSearchResponse,
  UploadDocumentsResponse,
} from '@raglab/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPgProbe } from '../../src/db/probe.js';
import { createLexicalEmbeddingProvider } from '../../src/eval/lexical-embedding-provider.js';
import {
  EmbeddingProviderError,
  type EmbeddingProvider,
} from '../../src/modules/embeddings/embedding-provider.js';
import { SHUTDOWN_MESSAGE } from '../../src/modules/ingestion/document-indexer.js';
import { createServices, type AppServices } from '../../src/services.js';
import { createFakeChatProvider, type FakeChatProvider } from '../fakes/fake-chat-provider.js';
import { silentLogger, testConfig } from '../helpers.js';
import { multipart } from '../multipart.js';
import { parseSse } from '../sse.js';
import { count, integrationDatabaseUrl, resetDatabase } from './setup.js';

/**
 * End to end over HTTP against PostgreSQL: upload → index (chunking + embedding) → search →
 * playground → chat → delete, plus provider failures and a shutdown during indexing. Providers
 * are deterministic stand-ins: the lexical baseline (so the right document is actually found)
 * and a scripted chat model.
 */
const databaseUrl = integrationDatabaseUrl();
const connection = createDatabase(databaseUrl, 4);
const { pool } = connection;
const config = testConfig({ DATABASE_URL: databaseUrl, CHUNK_SIZE: '600', CHUNK_OVERLAP: '100' });
const dataset = new URL('../../../../eval/datasets/raglab-docs/', import.meta.url);
const FILES = ['sourdough-baking.md', 'bicycle-maintenance.md', 'coffee-brewing.md'];

/** Lexical baseline whose failures can be switched on (simulates Ollama going away). */
const lexical = createLexicalEmbeddingProvider(768);
let embeddingFailure: Error | undefined;
const embedding: EmbeddingProvider = {
  ...lexical,
  embed: (texts, signal) =>
    embeddingFailure ? Promise.reject(embeddingFailure) : lexical.embed(texts, signal),
};
const chat: FakeChatProvider = createFakeChatProvider({
  tokens: ['Road tyres ', 'run at 5.5 to 7 bar [1].'],
});

function servicesWith(provider: EmbeddingProvider): AppServices {
  return createServices(connection.db, config, silentLogger, {
    embeddingProvider: provider,
    chatProvider: chat,
    collectionEmbedding: { provider: lexical.id, model: lexical.model, dimensions: 768 },
  });
}

async function start(services: AppServices): Promise<FastifyInstance> {
  return buildApp({
    config,
    probe: createPgProbe(pool, { embeddingDimensions: config.embedding.dimensions }),
    services,
    logger: false,
    sseHeartbeatMs: 0,
  });
}

let app: FastifyInstance;
let services: AppServices;

beforeAll(async () => {
  await runMigrations(databaseUrl);
  services = servicesWith(embedding);
  app = await start(services);
});

beforeEach(async () => {
  await resetDatabase(pool);
  embeddingFailure = undefined;
  chat.calls.length = 0;
});

afterAll(async () => {
  await app.close();
  await resetDatabase(pool);
  await connection.close();
});

async function createCollection(name: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/collections', payload: { name } });
  expect(response.statusCode).toBe(201);
  return response.json<CollectionDto>().id;
}

async function upload(target: FastifyInstance, collectionId: string, filenames: string[]) {
  const files = await Promise.all(
    filenames.map(async (filename) => ({
      filename,
      content: await readFile(new URL(filename, dataset), 'utf8'),
    })),
  );
  const { payload, headers } = multipart(files);
  const response = await target.inject({
    method: 'POST',
    url: `/api/collections/${collectionId}/documents`,
    payload,
    headers,
  });
  expect(response.statusCode).toBe(202);
  return response.json<UploadDocumentsResponse>().documents.map((document) => document.id);
}

const search = (collectionId: string, query: string) =>
  app.inject({
    method: 'POST',
    url: '/api/retrieval/search',
    payload: { collectionId, query, topK: 3 },
  });

describe('end to end over HTTP (PostgreSQL, deterministic providers)', () => {
  it('upload → index → search → playground → chat → delete', async () => {
    const collectionId = await createCollection('Handbook');
    const ids = await upload(app, collectionId, FILES);
    await Promise.all(ids.map((id) => services.ingestion.indexer?.index(id)));

    const documents = await app.inject({ url: `/api/collections/${collectionId}/documents` });
    expect(documents.json<DocumentListResponse>().items.map((document) => document.status)).toEqual(
      ['ready', 'ready', 'ready'],
    );
    const collection = (
      await app.inject({ url: `/api/collections/${collectionId}` })
    ).json<CollectionDto>();
    expect(collection).toMatchObject({ documentCount: 3, readyDocumentCount: 3 });
    expect(collection.chunkCount).toBeGreaterThan(3);
    expect(collection).toMatchObject({
      embeddingProvider: 'lexical-baseline',
      embeddingDimensions: 768,
    });

    // Search finds the right section.
    const question = 'What pressure should road bike tyres have?';
    const searched = await search(collectionId, question);
    expect(searched.statusCode).toBe(200);
    const results = searched.json<RetrievalSearchResponse>().results;
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ rank: 1, filename: 'bicycle-maintenance.md' });
    expect(results[0]?.headingPath).toContain('Tyre pressure');
    expect(results[0]?.content).toContain('5.5 to 7 bar');

    // The playground shows exactly what chat would use.
    const playground = await app.inject({
      method: 'POST',
      url: '/api/playground/search',
      payload: { collectionId, query: question, topK: 3 },
    });
    expect(playground.statusCode).toBe(200);
    expect(playground.json<PlaygroundSearchResponse>().results.map((hit) => hit.chunkId)).toEqual(
      results.map((hit) => hit.chunkId),
    );

    // Chat: same sources, answer streamed, citation mapped.
    const answered = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { collectionId, question, topK: 3 },
    });
    expect(answered.statusCode).toBe(200);
    const events = parseSse(answered.body);
    expect(events.map((event) => event.event)).toEqual(['sources', 'token', 'token', 'done']);
    const { sources } = events[0]?.data as ChatSourcesEvent;
    expect(sources.map((source) => source.chunkId)).toEqual(results.map((hit) => hit.chunkId));
    expect(events.at(-1)?.data as ChatDoneEvent).toMatchObject({
      answerStatus: 'answered',
      citedSources: [1],
      unknownCitations: [],
    });
    expect(chat.calls[0]?.messages.at(-1)?.content).toContain('5.5 to 7 bar');

    // Delete: everything is gone, the collection cannot be searched any more.
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/collections/${collectionId}` })).statusCode,
    ).toBe(204);
    const gone = await search(collectionId, question);
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toMatchObject({ error: { code: 'COLLECTION_NOT_FOUND' } });
    expect(await count(pool, 'documents')).toBe(0);
    expect(await count(pool, 'chunks')).toBe(0);
  });

  it('maps an unreachable embedding provider to 503 for search and chat and recovers', async () => {
    const collectionId = await createCollection('Handbook');
    const ids = await upload(app, collectionId, FILES.slice(0, 1));
    await services.ingestion.indexer?.index(ids[0] ?? '');

    embeddingFailure = new EmbeddingProviderError(
      'PROVIDER_UNREACHABLE',
      'Ollama is not reachable.',
    );
    const searched = await search(collectionId, 'feeding the starter');
    expect(searched.statusCode).toBe(503);
    expect(searched.json()).toMatchObject({
      error: {
        code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
        details: { providerCode: 'PROVIDER_UNREACHABLE' },
      },
    });
    const chatted = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { collectionId, question: 'feeding the starter' },
    });
    expect(chatted.statusCode).toBe(503);
    expect(chat.calls).toHaveLength(0);

    embeddingFailure = undefined;
    expect((await search(collectionId, 'feeding the starter')).statusCode).toBe(200);
  });

  it('marks a document failed when the server shuts down during indexing; reindex recovers it', async () => {
    // A provider that hangs until the indexer aborts it.
    const hanging: EmbeddingProvider = {
      ...lexical,
      embed: (_texts, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    };
    const stalled = servicesWith(hanging);
    const stalledApp = await start(stalled);
    const collectionId = await createCollection('Shutdown');
    const [id = ''] = await upload(stalledApp, collectionId, FILES.slice(1, 2));
    const indexing = stalled.ingestion.indexer?.index(id);

    await stalledApp.close(); // Fastify onClose → indexer.close() aborts the running job.
    await indexing;

    const failed = (await app.inject({ url: `/api/documents/${id}` })).json<DocumentDto>();
    expect(failed).toMatchObject({ status: 'failed', errorMessage: SHUTDOWN_MESSAGE });

    const reindexed = await app.inject({ method: 'POST', url: `/api/documents/${id}/reindex` });
    expect(reindexed.statusCode).toBe(202);
    await services.ingestion.indexer?.index(id);
    expect((await app.inject({ url: `/api/documents/${id}` })).json<DocumentDto>().status).toBe(
      'ready',
    );
  });
});
