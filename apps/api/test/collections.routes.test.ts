import type { ApiErrorResponse, CollectionDto, CollectionListResponse } from '@raglab/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppServices } from '../src/services.js';
import {
  createInMemoryServices,
  createInMemoryStore,
  fakeDocument,
  healthyProbe,
} from './fakes.js';
import type { InMemoryStore } from './fakes.js';
import { testConfig } from './helpers.js';

let app: FastifyInstance | undefined;
let store: InMemoryStore;

async function start(services?: AppServices): Promise<FastifyInstance> {
  const config = testConfig();
  store = createInMemoryStore();
  app = await buildApp({
    config,
    probe: healthyProbe,
    services: services ?? createInMemoryServices(config, store),
    logger: false,
  });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const UNKNOWN_ID = '0195f2a0-0000-7000-8000-000000000000';

async function create(api: FastifyInstance, payload: object) {
  return api.inject({ method: 'POST', url: '/api/collections', payload });
}

describe('POST /api/collections', () => {
  it('creates a collection with the configured embedding settings', async () => {
    const api = await start();

    const response = await create(api, { name: 'Docs', description: 'Project docs' });

    expect(response.statusCode).toBe(201);
    expect(response.json<CollectionDto>()).toMatchObject({
      name: 'Docs',
      description: 'Project docs',
      embeddingProvider: 'ollama',
      embeddingModel: 'test-embedding-model',
      embeddingDimensions: 768,
      documentCount: 0,
    });
  });

  it('returns 409 COLLECTION_NAME_TAKEN for a case-insensitive duplicate', async () => {
    const api = await start();
    await create(api, { name: 'Docs' });

    const response = await create(api, { name: 'docs' });

    expect(response.statusCode).toBe(409);
    expect(response.json<ApiErrorResponse>().error).toMatchObject({
      code: 'COLLECTION_NAME_TAKEN',
      details: { name: 'docs' },
    });
  });

  it.each([
    ['missing name', {}],
    ['empty name', { name: '' }],
    ['whitespace-only name', { name: '   ' }],
    ['name too long', { name: 'x'.repeat(121) }],
    ['description too long', { name: 'Docs', description: 'x'.repeat(2001) }],
    ['client-provided embedding model', { name: 'Docs', embeddingModel: 'other' }],
  ])('rejects %s with 400 VALIDATION_ERROR', async (_label, payload) => {
    const api = await start();

    const response = await create(api, payload);

    expect(response.statusCode).toBe(400);
    expect(response.json<ApiErrorResponse>().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/collections', () => {
  it('lists collections with document and chunk counts', async () => {
    const api = await start();
    const created = (await create(api, { name: 'Docs' })).json<CollectionDto>();
    store.documents.set('d1', fakeDocument({ id: 'd1', collectionId: created.id, chunkCount: 4 }));
    store.documents.set(
      'd2',
      fakeDocument({ id: 'd2', collectionId: created.id, status: 'failed', chunkCount: 0 }),
    );

    const response = await api.inject({ method: 'GET', url: '/api/collections' });

    expect(response.statusCode).toBe(200);
    expect(response.json<CollectionListResponse>().items).toEqual([
      expect.objectContaining({
        id: created.id,
        documentCount: 2,
        readyDocumentCount: 1,
        chunkCount: 4,
      }),
    ]);
  });
});

describe('GET /api/collections/:id', () => {
  it('returns the collection', async () => {
    const api = await start();
    const created = (await create(api, { name: 'Docs' })).json<CollectionDto>();

    const response = await api.inject({ method: 'GET', url: `/api/collections/${created.id}` });

    expect(response.statusCode).toBe(200);
    expect(response.json<CollectionDto>()).toEqual(created);
  });

  it('returns 404 COLLECTION_NOT_FOUND for an unknown id', async () => {
    const api = await start();

    const response = await api.inject({ method: 'GET', url: `/api/collections/${UNKNOWN_ID}` });

    expect(response.statusCode).toBe(404);
    expect(response.json<ApiErrorResponse>().error.code).toBe('COLLECTION_NOT_FOUND');
  });

  it('returns 400 for a malformed id', async () => {
    const api = await start();

    const response = await api.inject({ method: 'GET', url: '/api/collections/123' });

    expect(response.statusCode).toBe(400);
    expect(response.json<ApiErrorResponse>().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PATCH /api/collections/:id', () => {
  it('renames a collection and updates the description', async () => {
    const api = await start();
    const created = (await create(api, { name: 'Docs', description: 'old' })).json<CollectionDto>();

    const response = await api.inject({
      method: 'PATCH',
      url: `/api/collections/${created.id}`,
      payload: { name: 'Handbook', description: null },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<CollectionDto>()).toMatchObject({
      id: created.id,
      name: 'Handbook',
      description: null,
    });
  });

  it('rejects changes to the embedding settings', async () => {
    const api = await start();
    const created = (await create(api, { name: 'Docs' })).json<CollectionDto>();

    const response = await api.inject({
      method: 'PATCH',
      url: `/api/collections/${created.id}`,
      payload: { embeddingDimensions: 1024 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ApiErrorResponse>().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an empty body', async () => {
    const api = await start();
    const created = (await create(api, { name: 'Docs' })).json<CollectionDto>();

    const response = await api.inject({
      method: 'PATCH',
      url: `/api/collections/${created.id}`,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 409 when renaming onto an existing name', async () => {
    const api = await start();
    await create(api, { name: 'Docs' });
    const other = (await create(api, { name: 'Other' })).json<CollectionDto>();

    const response = await api.inject({
      method: 'PATCH',
      url: `/api/collections/${other.id}`,
      payload: { name: 'DOCS' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<ApiErrorResponse>().error.code).toBe('COLLECTION_NAME_TAKEN');
  });
});

describe('DELETE /api/collections/:id', () => {
  it('deletes the collection with 204 and then reports 404', async () => {
    const api = await start();
    const created = (await create(api, { name: 'Docs' })).json<CollectionDto>();

    const deleted = await api.inject({ method: 'DELETE', url: `/api/collections/${created.id}` });
    const again = await api.inject({ method: 'DELETE', url: `/api/collections/${created.id}` });

    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe('');
    expect(again.statusCode).toBe(404);
  });
});

describe('collections routes with a failing service', () => {
  it('answers 500 INTERNAL_ERROR without leaking the cause', async () => {
    const config = testConfig();
    const services = createInMemoryServices(config);
    const api = await start({
      ...services,
      collections: {
        ...services.collections,
        list: async () => {
          throw new Error('password authentication failed for user "raglab"');
        },
      },
    });

    const response = await api.inject({ method: 'GET', url: '/api/collections' });

    expect(response.statusCode).toBe(500);
    expect(response.json<ApiErrorResponse>().error.code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toContain('password');
  });
});

describe('OpenAPI', () => {
  it('documents request and error schemas of the collection routes', async () => {
    const api = await start();

    const spec = (await api.inject({ method: 'GET', url: '/api/docs/json' })).json<{
      paths: Record<string, Record<string, { requestBody?: unknown; responses: object }>>;
    }>();

    const post = spec.paths['/api/collections']?.['post'];
    expect(post?.requestBody).toBeDefined();
    expect(Object.keys(post?.responses ?? {})).toEqual(
      expect.arrayContaining(['201', '400', '409']),
    );
    expect(Object.keys(spec.paths['/api/collections/{id}'] ?? {})).toEqual(
      expect.arrayContaining(['get', 'patch', 'delete']),
    );
  });
});
