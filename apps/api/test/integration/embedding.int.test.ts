import type {
  CollectionDto,
  DocumentDto,
  ProvidersStatusResponse,
  UploadDocumentsResponse,
} from '@raglab/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPgProbe } from '../../src/db/probe.js';
import { createChunksRepository } from '../../src/modules/chunking/chunks.repository.js';
import { createServices, type AppServices } from '../../src/services.js';
import {
  createFakeEmbeddingProvider,
  fakeVector,
  modelNotFound,
  type FakeEmbeddingProvider,
} from '../fakes/fake-embedding-provider.js';
import { silentLogger, testConfig } from '../helpers.js';
import { multipart } from '../multipart.js';
import { insertChunk, insertDocument, integrationDatabaseUrl, resetDatabase } from './setup.js';

const databaseUrl = integrationDatabaseUrl();
const connection = createDatabase(databaseUrl, 4);
const { pool } = connection;
const config = testConfig({ DATABASE_URL: databaseUrl, CHUNK_SIZE: '200', CHUNK_OVERLAP: '20' });
const provider: FakeEmbeddingProvider = createFakeEmbeddingProvider({ dimensions: 768 });
let app: FastifyInstance;
let services: AppServices;

beforeAll(async () => {
  await runMigrations(databaseUrl);
  // Default wiring as in main.ts; only the provider is a fake (no Ollama in CI).
  services = createServices(connection.db, config, silentLogger, { embeddingProvider: provider });
  app = await buildApp({
    config,
    probe: createPgProbe(pool, { embeddingDimensions: config.embedding.dimensions }),
    services,
    logger: false,
  });
});

beforeEach(async () => {
  await resetDatabase(pool);
  provider.failWith = undefined;
  provider.calls.length = 0;
});

afterAll(async () => {
  await app.close();
  await resetDatabase(pool);
  await connection.close();
});

async function createCollection(name = 'Docs'): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/collections', payload: { name } });
  return response.json<CollectionDto>().id;
}

async function uploadAndIndex(collectionId: string, content: string): Promise<string> {
  const { payload, headers } = multipart([{ filename: 'guide.md', content }]);
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

async function reindexAndWait(id: string) {
  const response = await app.inject({ method: 'POST', url: `/api/documents/${id}/reindex` });
  if (response.statusCode === 202) {
    await services.ingestion.indexer?.index(id);
  }
  return response;
}

async function documentRow(id: string) {
  const result = await pool.query<{
    status: string;
    chunk_count: number;
    error_message: string | null;
  }>('SELECT status, chunk_count, error_message FROM documents WHERE id = $1', [id]);
  return result.rows[0];
}

async function embeddingRows(documentId: string) {
  const result = await pool.query<{
    content: string;
    dims: number | null;
    embedding: string | null;
  }>(
    `SELECT content, vector_dims(embedding) AS dims, embedding::text AS embedding
       FROM chunks WHERE document_id = $1 ORDER BY chunk_index`,
    [documentId],
  );
  return result.rows;
}

const SAMPLE = [
  '# Guide',
  '',
  'RAGLab stores one vector per chunk. The vector column has a fixed dimension.',
  '',
  '## Embeddings',
  '',
  'Embeddings come from the configured provider. Models are never mixed within a collection.',
].join('\n');

describe('embedding pipeline against PostgreSQL', () => {
  it('stores a 768-dimensional vector for every chunk and marks the document ready', async () => {
    const collectionId = await createCollection();

    const id = await uploadAndIndex(collectionId, SAMPLE);

    const rows = await embeddingRows(id);
    expect(rows.length).toBeGreaterThan(1);
    expect(await documentRow(id)).toMatchObject({
      status: 'ready',
      chunk_count: rows.length,
      error_message: null,
    });
    for (const row of rows) {
      expect(row.dims).toBe(768);
      // Stored exactly as returned by the provider (no normalisation, no truncation).
      const stored = JSON.parse(row.embedding ?? '[]') as number[];
      const expected = fakeVector(row.content, 768);
      expect(stored).toHaveLength(768);
      stored.forEach((value, index) => {
        expect(value).toBeCloseTo(expected[index] ?? NaN, 6);
      });
    }
    const chunks = await app.inject({ method: 'GET', url: `/api/documents/${id}/chunks` });
    expect(
      chunks.json<{ chunks: { hasEmbedding: boolean }[] }>().chunks.every((c) => c.hasEmbedding),
    ).toBe(true);
  });

  it('marks the document failed when the model is missing and indexes it after a reindex', async () => {
    const collectionId = await createCollection();
    provider.failWith = modelNotFound();

    const id = await uploadAndIndex(collectionId, SAMPLE);

    const failed = await documentRow(id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error_message).toContain('ollama pull test-embedding-model');
    expect((await embeddingRows(id)).every((row) => row.dims === null)).toBe(true);

    provider.failWith = undefined;
    const response = await reindexAndWait(id);

    expect(response.statusCode).toBe(202);
    expect(response.json<DocumentDto>().status).toBe('pending');
    expect(await documentRow(id)).toMatchObject({ status: 'ready', error_message: null });
    expect((await embeddingRows(id)).every((row) => row.dims === 768)).toBe(true);
  });

  it('reindexes a ready document whose chunks have no embeddings (indexed before 006)', async () => {
    const collectionId = await createCollection();
    const id = await insertDocument(pool, collectionId, { status: 'ready', chunkCount: 1 });
    await insertChunk(pool, id, collectionId, 0, 'old chunk without vector');

    const response = await reindexAndWait(id);

    expect(response.statusCode).toBe(202);
    expect(await documentRow(id)).toMatchObject({ status: 'ready', chunk_count: 1 });
    const rows = await embeddingRows(id);
    // Re-chunked from documents.content and embedded.
    expect(rows.map((row) => [row.content, row.dims])).toEqual([['# Guide\nHello', 768]]);

    const again = await reindexAndWait(id);
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: { code: string } }>().error.code).toBe('DOCUMENT_ALREADY_INDEXED');
  });

  it('refuses to index a collection that uses another embedding model', async () => {
    const collectionId = await createCollection();
    await pool.query(`UPDATE collections SET embedding_model = 'other-model' WHERE id = $1`, [
      collectionId,
    ]);

    const id = await uploadAndIndex(collectionId, SAMPLE);

    const row = await documentRow(id);
    expect(row?.status).toBe('failed');
    expect(row?.error_message).toMatch(/^EMBEDDING_MODEL_MISMATCH: .*"other-model"/);
    expect(provider.calls).toEqual([]);
    expect((await embeddingRows(id)).every((r) => r.dims === null)).toBe(true);
  });

  it('stores all vectors of a document in one transaction (nothing on failure)', async () => {
    const collectionId = await createCollection();
    const id = await insertDocument(pool, collectionId, { status: 'processing' });
    const chunkId = await insertChunk(pool, id, collectionId, 0, 'a');
    const repository = createChunksRepository(connection.db);

    await expect(
      repository.storeEmbeddings(id, [
        { chunkId, embedding: fakeVector('a', 768) },
        // Unknown chunk → the whole write is rolled back.
        { chunkId: '0195f2a0-0000-7000-8000-000000000000', embedding: fakeVector('b', 768) },
      ]),
    ).rejects.toThrow(/chunks changed/);
    expect((await embeddingRows(id))[0]?.dims).toBeNull();

    // The column itself rejects other dimensions as well.
    await expect(
      repository.storeEmbeddings(id, [{ chunkId, embedding: fakeVector('a', 767) }]),
    ).rejects.toThrow();
    expect((await embeddingRows(id))[0]?.dims).toBeNull();
    expect(await repository.countWithoutEmbedding(id)).toBe(1);
  });

  it('reports the real column dimension in GET /api/system/providers', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/system/providers' });

    expect(response.statusCode).toBe(200);
    expect(response.json<ProvidersStatusResponse>().embedding.dimensions).toEqual({
      configured: 768,
      column: 768,
    });
  });
});
