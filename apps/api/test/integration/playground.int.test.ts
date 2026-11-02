import type {
  ChatSourcesEvent,
  PlaygroundSearchResponse,
  RetrievalSearchResponse,
} from '@raglab/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPgProbe } from '../../src/db/probe.js';
import { toVectorLiteral } from '../../src/db/vector.js';
import { createServices, type AppServices } from '../../src/services.js';
import { createFakeChatProvider } from '../fakes/fake-chat-provider.js';
import { createFakeEmbeddingProvider } from '../fakes/fake-embedding-provider.js';
import { silentLogger, testConfig } from '../helpers.js';
import { parseSse } from '../sse.js';
import { insertChunk, insertDocument, integrationDatabaseUrl, resetDatabase } from './setup.js';

/**
 * Playground against the real database: index statistics (documents by status, chunks without
 * embedding) and consistency with chat's source selection over the pgvector search. Vectors are
 * hand-made, the providers are fakes; the chat provider must never be called by the playground.
 */
const DIMENSIONS = 768;

function unit(index: number): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  vector[index] = 1;
  return vector;
}

/** e0 rotated towards e1 by `angle` radians: cosine distance to e0 is `1 - cos(angle)`. */
function towards(angle: number): number[] {
  const vector = unit(0).map((value) => value * Math.cos(angle));
  vector[1] = Math.sin(angle);
  return vector;
}

const QUERY = 'query e0';
const databaseUrl = integrationDatabaseUrl();
const connection = createDatabase(databaseUrl, 4);
const { pool } = connection;
// Budget 1000: each chunk below renders to 363 characters, so two fit into the prompt.
const config = testConfig({ DATABASE_URL: databaseUrl, CHAT_CONTEXT_CHAR_BUDGET: '1000' });
const chat = createFakeChatProvider();
let app: FastifyInstance;
let services: AppServices;

beforeAll(async () => {
  await runMigrations(databaseUrl);
  services = createServices(connection.db, config, silentLogger, {
    embeddingProvider: createFakeEmbeddingProvider({
      dimensions: DIMENSIONS,
      vectorFor: (text) => (text === QUERY ? unit(0) : undefined),
    }),
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

async function insertCollection(name = 'Docs'): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO collections (name, embedding_provider, embedding_model, embedding_dimensions)
     VALUES ($1, 'ollama', $2, $3) RETURNING id`,
    [name, config.embedding.model, DIMENSIONS],
  );
  return result.rows[0]?.id ?? '';
}

let documentCounter = 0;

async function addDocument(collectionId: string, status: string): Promise<string> {
  documentCounter++;
  return insertDocument(pool, collectionId, {
    status,
    contentSha256: documentCounter.toString(16).padStart(64, '0'),
  });
}

async function addChunk(
  documentId: string,
  collectionId: string,
  chunkIndex: number,
  embedding: number[] | null,
): Promise<string> {
  const id = await insertChunk(
    pool,
    documentId,
    collectionId,
    chunkIndex,
    `chunk ${chunkIndex} ${'x'.repeat(300)}`,
  );
  if (embedding) {
    await pool.query('UPDATE chunks SET embedding = $1::vector WHERE id = $2', [
      toVectorLiteral(embedding),
      id,
    ]);
  }
  return id;
}

const playground = (payload: object) =>
  app.inject({ method: 'POST', url: '/api/playground/search', payload });

describe('POST /api/playground/search (PostgreSQL)', () => {
  it('counts documents by status, searchable chunks and chunks without embedding', async () => {
    const collectionId = await insertCollection();
    const ready = await addDocument(collectionId, 'ready');
    const failed = await addDocument(collectionId, 'failed');
    await addDocument(collectionId, 'pending');
    await addDocument(collectionId, 'processing');
    await addChunk(ready, collectionId, 0, towards(0.1));
    await addChunk(ready, collectionId, 1, towards(0.2));
    await addChunk(ready, collectionId, 2, null);
    // Embedded but not searchable: its document is not ready.
    await addChunk(failed, collectionId, 0, towards(0.05));
    // Documents and chunks of another collection are not counted.
    const other = await insertCollection('Other');
    await addChunk(await addDocument(other, 'ready'), other, 0, null);

    const response = await playground({ collectionId, query: QUERY, topK: 10 });

    expect(response.statusCode).toBe(200);
    const body = response.json<PlaygroundSearchResponse>();
    expect(body.stats).toEqual({
      documentCount: 4,
      documentsByStatus: { pending: 1, processing: 1, ready: 1, failed: 1 },
      chunkCount: 4,
      searchableChunkCount: 2,
      chunksWithoutEmbedding: 1,
    });
    expect(body.results.map((result) => result.chunkIndex)).toEqual([0, 1]);
    expect(body.warnings.map((warning) => warning.code)).toEqual([
      'DOCUMENTS_NOT_READY',
      'DOCUMENTS_FAILED',
      'CHUNKS_WITHOUT_EMBEDDING',
    ]);
  });

  it.each([undefined, 0.96])(
    'matches the retrieval endpoint and flags exactly chat’s sources (minScore %s)',
    async (minScore) => {
      const collectionId = await insertCollection();
      const documentId = await addDocument(collectionId, 'ready');
      // Scores cos(angle): 0.995, 0.980, 0.955, 0.921, 0.878 – two reach minScore 0.96.
      for (const [index, angle] of [0.1, 0.2, 0.3, 0.4, 0.5].entries()) {
        await addChunk(documentId, collectionId, index, towards(angle));
      }
      const common = { collectionId, topK: 5, ...(minScore !== undefined ? { minScore } : {}) };

      const body = (
        await playground({ ...common, query: QUERY, includePrompt: true })
      ).json<PlaygroundSearchResponse>();
      const retrieval = (
        await app.inject({
          method: 'POST',
          url: '/api/retrieval/search',
          payload: { collectionId, query: QUERY, topK: 5 },
        })
      ).json<RetrievalSearchResponse>();
      const chatResponse = await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: { ...common, question: QUERY },
      });
      const { sources } = parseSse(chatResponse.body)[0]?.data as ChatSourcesEvent;

      // Same chunks, order and scores as the retrieval endpoint (without minScore).
      expect(
        body.results.map(({ chunkId, score, distance }) => ({ chunkId, score, distance })),
      ).toEqual(
        retrieval.results.map(({ chunkId, score, distance }) => ({ chunkId, score, distance })),
      );
      // includedInChatContext = chat's sources, in order, with identical scores.
      const included = body.results.filter((result) => result.includedInChatContext);
      expect(included.map(({ chunkId, score, rank }) => ({ chunkId, score, rank }))).toEqual(
        sources.map(({ chunkId, score, n }) => ({ chunkId, score, rank: n })),
      );
      expect(included).toHaveLength(2);
      expect(body.chatContext).toMatchObject({
        includedCount: 2,
        belowMinScoreCount: minScore === undefined ? 0 : 3,
        omittedByBudgetCount: minScore === undefined ? 3 : 0,
      });
      expect(body.results.filter((result) => result.belowMinScore)).toHaveLength(
        minScore === undefined ? 0 : 3,
      );
      // The prompt preview is exactly what the chat model received.
      expect(body.prompt?.messages).toEqual(chat.calls[0]?.messages);
      expect(chat.calls).toHaveLength(1);
    },
  );
});
