import type {
  ApiErrorResponse,
  CollectionDto,
  CollectionListResponse,
  DocumentDto,
  DocumentListResponse,
} from '@raglab/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPgProbe } from '../../src/db/probe.js';
import { createServices } from '../../src/services.js';
import { createFakeEmbeddingProvider } from '../fakes/fake-embedding-provider.js';
import { silentLogger, testConfig } from '../helpers.js';
import {
  count,
  insertChunk,
  insertDocument,
  integrationDatabaseUrl,
  resetDatabase,
} from './setup.js';

const databaseUrl = integrationDatabaseUrl();
const connection = createDatabase(databaseUrl, 2);
const { pool } = connection;
let app: FastifyInstance;

beforeAll(async () => {
  await runMigrations(databaseUrl);
  const config = testConfig({
    DATABASE_URL: databaseUrl,
    EMBEDDING_MODEL: 'integration-embedding-model',
  });
  app = await buildApp({
    config,
    probe: createPgProbe(pool, { embeddingDimensions: config.embedding.dimensions }),
    services: createServices(connection.db, config, silentLogger, {
      embeddingProvider: createFakeEmbeddingProvider(),
    }),
    logger: false,
  });
});

beforeEach(async () => {
  await resetDatabase(pool);
});

afterAll(async () => {
  await app.close();
  await resetDatabase(pool);
  await connection.close();
});

async function createCollection(payload: object) {
  return app.inject({ method: 'POST', url: '/api/collections', payload });
}

describe('collections API against PostgreSQL', () => {
  it('creates, reads, updates and lists a collection', async () => {
    const createdResponse = await createCollection({ name: ' Docs ', description: 'Project docs' });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json<CollectionDto>();
    expect(created).toMatchObject({
      name: 'Docs',
      description: 'Project docs',
      embeddingProvider: 'ollama',
      embeddingModel: 'integration-embedding-model',
      embeddingDimensions: 768,
      documentCount: 0,
      readyDocumentCount: 0,
      chunkCount: 0,
    });

    const fetched = await app.inject({ method: 'GET', url: `/api/collections/${created.id}` });
    expect(fetched.json<CollectionDto>()).toEqual(created);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/collections/${created.id}`,
      payload: { name: 'Handbook', description: null },
    });
    expect(patched.statusCode).toBe(200);
    const updated = patched.json<CollectionDto>();
    expect(updated).toMatchObject({ id: created.id, name: 'Handbook', description: null });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.updatedAt));

    const list = await app.inject({ method: 'GET', url: '/api/collections' });
    expect(list.json<CollectionListResponse>().items.map((item) => item.name)).toEqual([
      'Handbook',
    ]);
  });

  it('rejects case-insensitive duplicate names with 409 COLLECTION_NAME_TAKEN', async () => {
    await createCollection({ name: 'Docs' });

    const duplicate = await createCollection({ name: 'docs' });

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json<ApiErrorResponse>().error.code).toBe('COLLECTION_NAME_TAKEN');
  });

  it('allows renaming a collection to a different casing of its own name', async () => {
    const created = (await createCollection({ name: 'docs' })).json<CollectionDto>();

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/collections/${created.id}`,
      payload: { name: 'Docs' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<CollectionDto>().name).toBe('Docs');
  });

  it('counts documents, ready documents and chunks', async () => {
    const created = (await createCollection({ name: 'Docs' })).json<CollectionDto>();
    const ready = await insertDocument(pool, created.id, { contentSha256: '1'.repeat(64) });
    await insertDocument(pool, created.id, { contentSha256: '2'.repeat(64), status: 'pending' });
    await insertChunk(pool, ready, created.id, 0);
    await insertChunk(pool, ready, created.id, 1);

    const response = await app.inject({ method: 'GET', url: `/api/collections/${created.id}` });

    expect(response.json<CollectionDto>()).toMatchObject({
      documentCount: 2,
      readyDocumentCount: 1,
      chunkCount: 2,
    });
  });

  it('deletes a collection with its documents and chunks', async () => {
    const created = (await createCollection({ name: 'Docs' })).json<CollectionDto>();
    const documentId = await insertDocument(pool, created.id);
    await insertChunk(pool, documentId, created.id, 0);

    const deleted = await app.inject({ method: 'DELETE', url: `/api/collections/${created.id}` });

    expect(deleted.statusCode).toBe(204);
    expect(await count(pool, 'collections')).toBe(0);
    expect(await count(pool, 'documents')).toBe(0);
    expect(await count(pool, 'chunks')).toBe(0);
    const again = await app.inject({ method: 'GET', url: `/api/collections/${created.id}` });
    expect(again.statusCode).toBe(404);
  });
});

describe('documents API against PostgreSQL', () => {
  it('lists and reads document metadata without content', async () => {
    const collection = (await createCollection({ name: 'Docs' })).json<CollectionDto>();
    const documentId = await insertDocument(pool, collection.id, { chunkCount: 1 });

    const list = await app.inject({
      method: 'GET',
      url: `/api/collections/${collection.id}/documents`,
    });
    const single = await app.inject({ method: 'GET', url: `/api/documents/${documentId}` });

    expect(list.statusCode).toBe(200);
    const items = list.json<DocumentListResponse>().items;
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty('content');
    expect(single.json<DocumentDto>()).toMatchObject({
      id: documentId,
      collectionId: collection.id,
      status: 'ready',
      errorMessage: null,
      chunkCount: 1,
      metadata: {},
    });
    expect(single.body).not.toContain('Hello');
  });

  it('deletes a document with its chunks but keeps the collection', async () => {
    const collection = (await createCollection({ name: 'Docs' })).json<CollectionDto>();
    const documentId = await insertDocument(pool, collection.id);
    await insertChunk(pool, documentId, collection.id, 0);

    const deleted = await app.inject({ method: 'DELETE', url: `/api/documents/${documentId}` });

    expect(deleted.statusCode).toBe(204);
    expect(await count(pool, 'chunks')).toBe(0);
    expect(await count(pool, 'collections')).toBe(1);
  });

  it('returns 404 for documents of an unknown collection', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/collections/0195f2a0-0000-7000-8000-000000000000/documents',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<ApiErrorResponse>().error.code).toBe('COLLECTION_NOT_FOUND');
  });
});
