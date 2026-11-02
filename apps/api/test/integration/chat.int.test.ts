import type {
  ChatDoneEvent,
  ChatSourcesEvent,
  CollectionDto,
  UploadDocumentsResponse,
} from '@raglab/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPgProbe } from '../../src/db/probe.js';
import { createServices, type AppServices } from '../../src/services.js';
import { createFakeChatProvider, type FakeChatProvider } from '../fakes/fake-chat-provider.js';
import { createFakeEmbeddingProvider } from '../fakes/fake-embedding-provider.js';
import { silentLogger, testConfig } from '../helpers.js';
import { multipart } from '../multipart.js';
import { parseSse } from '../sse.js';
import { integrationDatabaseUrl, resetDatabase } from './setup.js';

/**
 * Chat against the real database and retrieval SQL: upload → chunk → embed (fake) → retrieval
 * (pgvector) → prompt → SSE. Only the providers are fakes (no Ollama in CI).
 */
const databaseUrl = integrationDatabaseUrl();
const connection = createDatabase(databaseUrl, 4);
const { pool } = connection;
const config = testConfig({ DATABASE_URL: databaseUrl, CHUNK_SIZE: '200', CHUNK_OVERLAP: '0' });
const chat: FakeChatProvider = createFakeChatProvider({ tokens: ['Answer ', 'from [1] and [7].'] });
let app: FastifyInstance;
let services: AppServices;

beforeAll(async () => {
  await runMigrations(databaseUrl);
  services = createServices(connection.db, config, silentLogger, {
    embeddingProvider: createFakeEmbeddingProvider({ dimensions: 768 }),
    chatProvider: chat,
  });
  app = await buildApp({
    config,
    probe: createPgProbe(pool, { embeddingDimensions: config.embedding.dimensions }),
    services,
    logger: false,
    sseHeartbeatMs: 0,
  });
});

beforeEach(async () => {
  await resetDatabase(pool);
  chat.calls.length = 0;
});

afterAll(async () => {
  await app.close();
  await resetDatabase(pool);
  await connection.close();
});

async function createCollection(name: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/collections', payload: { name } });
  return response.json<CollectionDto>().id;
}

async function uploadAndIndex(collectionId: string, filename: string, content: string) {
  const { payload, headers } = multipart([{ filename, content }]);
  const response = await app.inject({
    method: 'POST',
    url: `/api/collections/${collectionId}/documents`,
    payload,
    headers,
  });
  expect(response.statusCode).toBe(202);
  const id = response.json<UploadDocumentsResponse>().documents[0]?.id ?? '';
  await services.ingestion.indexer?.index(id);
  return id;
}

const ask = (collectionId: string, question: string) =>
  app.inject({ method: 'POST', url: '/api/chat', payload: { collectionId, question, topK: 3 } });

describe('POST /api/chat (PostgreSQL)', () => {
  it('streams sources from the collection only, with stable ids, then tokens and done', async () => {
    const docs = await createCollection('Docs');
    const other = await createCollection('Other');
    const documentId = await uploadAndIndex(
      docs,
      'install.md',
      '# Install\n\nRun pnpm install to install all dependencies.\n',
    );
    await uploadAndIndex(
      other,
      'secret.md',
      '# Secret\n\nRun pnpm install to install all dependencies.\n',
    );

    const response = await ask(docs, 'Run pnpm install to install all dependencies.');

    expect(response.statusCode).toBe(200);
    const events = parseSse(response.body);
    expect(events.map((event) => event.event)).toEqual(['sources', 'token', 'token', 'done']);
    const { sources } = events[0]?.data as ChatSourcesEvent;
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source.documentId).toBe(documentId);
      expect(source.filename).toBe('install.md');
    }

    // The chunk ids are the stored ones.
    const chunks = await pool.query<{ id: string }>(
      'SELECT id FROM chunks WHERE document_id = $1',
      [documentId],
    );
    const storedIds = chunks.rows.map((row) => row.id);
    for (const source of sources) {
      expect(storedIds).toContain(source.chunkId);
    }

    const done = events.at(-1)?.data as ChatDoneEvent;
    expect(done).toMatchObject({
      answerStatus: 'answered',
      citedSources: [1],
      model: 'test-chat-model',
    });
    expect(done.unknownCitations).toEqual(sources.length >= 7 ? [] : [7]);
    expect(chat.calls[0]?.messages[1]?.content).not.toContain('secret.md');
  });

  it('answers no_sources for an empty collection without calling the model', async () => {
    const docs = await createCollection('Empty');

    const events = parseSse((await ask(docs, 'anything')).body);

    expect(events.map((event) => event.event)).toEqual(['sources', 'token', 'done']);
    expect((events[2]?.data as ChatDoneEvent).answerStatus).toBe('no_sources');
    expect(chat.calls).toEqual([]);
  });
});
