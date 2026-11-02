import type { ApiErrorResponse, DocumentDto, DocumentListResponse } from '@raglab/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  createInMemoryServices,
  createInMemoryStore,
  fakeDocument,
  healthyProbe,
  type InMemoryStore,
} from './fakes.js';
import { testConfig } from './helpers.js';

let app: FastifyInstance;
let store: InMemoryStore;
let collectionId: string;

const UNKNOWN_ID = '0195f2a0-0000-7000-8000-000000000000';

beforeEach(async () => {
  const config = testConfig();
  store = createInMemoryStore();
  const services = createInMemoryServices(config, store);
  app = await buildApp({ config, probe: healthyProbe, services, logger: false });
  collectionId = (await services.collections.create({ name: 'Docs' })).id;
});

afterEach(async () => {
  await app.close();
});

describe('GET /api/collections/:id/documents', () => {
  it('lists document metadata without content', async () => {
    const document = fakeDocument({ collectionId, metadata: { title: 'Guide' } });
    store.documents.set(document.id, document);

    const response = await app.inject({
      method: 'GET',
      url: `/api/collections/${collectionId}/documents`,
    });

    expect(response.statusCode).toBe(200);
    const { items } = response.json<DocumentListResponse>();
    expect(items).toEqual([
      {
        id: document.id,
        collectionId,
        filename: 'guide.md',
        mimeType: 'text/markdown',
        sizeBytes: 42,
        contentSha256: 'a'.repeat(64),
        status: 'ready',
        errorMessage: null,
        chunkCount: 3,
        metadata: { title: 'Guide' },
        createdAt: '2026-11-02T10:00:00.000Z',
        updatedAt: '2026-11-02T10:00:00.000Z',
      },
    ]);
    expect(items[0]).not.toHaveProperty('content');
  });

  it('strips content even if a service returns it (response schema)', async () => {
    const document = { ...fakeDocument({ collectionId }), content: 'SECRET FULL TEXT' };
    store.documents.set(document.id, document);

    const response = await app.inject({
      method: 'GET',
      url: `/api/collections/${collectionId}/documents`,
    });

    expect(response.body).not.toContain('SECRET FULL TEXT');
  });

  it('returns 404 COLLECTION_NOT_FOUND for an unknown collection', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/collections/${UNKNOWN_ID}/documents`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<ApiErrorResponse>().error.code).toBe('COLLECTION_NOT_FOUND');
  });
});

describe('GET /api/documents/:id', () => {
  it('returns status, error message and chunk count', async () => {
    const document = fakeDocument({
      collectionId,
      status: 'failed',
      errorMessage: 'File is not valid UTF-8',
      chunkCount: 0,
    });
    store.documents.set(document.id, document);

    const response = await app.inject({ method: 'GET', url: `/api/documents/${document.id}` });

    expect(response.statusCode).toBe(200);
    expect(response.json<DocumentDto>()).toMatchObject({
      status: 'failed',
      errorMessage: 'File is not valid UTF-8',
      chunkCount: 0,
    });
  });

  it('returns 404 DOCUMENT_NOT_FOUND and 400 for malformed ids', async () => {
    const missing = await app.inject({ method: 'GET', url: `/api/documents/${UNKNOWN_ID}` });
    const malformed = await app.inject({ method: 'GET', url: '/api/documents/abc' });

    expect(missing.statusCode).toBe(404);
    expect(missing.json<ApiErrorResponse>().error.code).toBe('DOCUMENT_NOT_FOUND');
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<ApiErrorResponse>().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('DELETE /api/documents/:id', () => {
  it('deletes with 204 and reports 404 afterwards', async () => {
    const document = fakeDocument({ collectionId });
    store.documents.set(document.id, document);

    const deleted = await app.inject({ method: 'DELETE', url: `/api/documents/${document.id}` });
    const again = await app.inject({ method: 'DELETE', url: `/api/documents/${document.id}` });

    expect(deleted.statusCode).toBe(204);
    expect(again.statusCode).toBe(404);
  });
});
