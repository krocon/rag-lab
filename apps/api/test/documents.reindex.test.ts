import type { ApiErrorResponse, DocumentDto } from '@raglab/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createChunkingStep } from '../src/modules/chunking/chunking.step.js';
import { createCollectionsService } from '../src/modules/collections/collections.service.js';
import { createDocumentsService } from '../src/modules/documents/documents.service.js';
import { createEmbeddingStep } from '../src/modules/embeddings/embedding.step.js';
import type { DocumentStatus } from '../src/db/schema.js';
import {
  createInMemoryChunksRepository,
  createInMemoryCollectionsRepository,
  createInMemoryDocumentsRepository,
  createInMemoryServices,
  createInMemoryStore,
  fakeDocument,
  healthyProbe,
  type InMemoryStore,
} from './fakes.js';
import { createFakeEmbeddingProvider } from './fakes/fake-embedding-provider.js';
import { testConfig } from './helpers.js';

const UNKNOWN_ID = '0195f2a0-0000-7000-8000-000000000000';
const config = testConfig();

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** App with the real pipeline (chunking + embedding) on in-memory repositories. */
async function start({ withIndexer = true }: { withIndexer?: boolean } = {}) {
  const store: InMemoryStore = createInMemoryStore();
  const chunks = createInMemoryChunksRepository(store);
  const collectionsForSteps = createCollectionsService({
    repository: createInMemoryCollectionsRepository(store),
    embedding: config.embedding,
  });
  const steps = withIndexer
    ? [
        createChunkingStep({ repository: chunks, options: config.chunking }),
        createEmbeddingStep({
          provider: createFakeEmbeddingProvider(),
          chunks,
          collections: collectionsForSteps,
          columnDimensions: 768,
        }),
      ]
    : [];
  const services = createInMemoryServices(config, store, { steps });
  app = await buildApp({ config, probe: healthyProbe, services, logger: false });
  const collectionId = (await services.collections.create({ name: 'Docs' })).id;

  function addDocument(status: DocumentStatus, overrides: { chunks?: boolean[] } = {}) {
    const document = {
      ...fakeDocument({ collectionId, status, chunkCount: overrides.chunks?.length ?? 0 }),
      content: '# Guide\n\nHello world.',
      errorMessage: status === 'failed' ? 'Embedding failed: …' : null,
    };
    store.documents.set(document.id, document);
    if (overrides.chunks) {
      store.chunks.set(
        document.id,
        overrides.chunks.map((hasEmbedding, index) => ({
          id: `${document.id}-${index}`,
          documentId: document.id,
          collectionId,
          chunkIndex: index,
          content: `chunk ${index}`,
          startOffset: 0,
          endOffset: 1,
          charCount: 7,
          tokenEstimate: 2,
          headingPath: [],
          metadata: {},
          hasEmbedding,
          createdAt: new Date(),
        })),
      );
    }
    return document.id;
  }

  const reindex = (id: string) =>
    (app as FastifyInstance).inject({ method: 'POST', url: `/api/documents/${id}/reindex` });

  return { services, store, addDocument, reindex };
}

describe('POST /api/documents/:id/reindex', () => {
  it('requeues a failed document (202, pending) and indexes it with embeddings', async () => {
    const { services, store, addDocument, reindex } = await start();
    const id = addDocument('failed');

    const response = await reindex(id);

    expect(response.statusCode).toBe(202);
    expect(response.json<DocumentDto>()).toMatchObject({
      id,
      status: 'pending',
      errorMessage: null,
    });
    await services.ingestion.indexer?.index(id);
    expect(store.documents.get(id)).toMatchObject({ status: 'ready', chunkCount: 1 });
    expect(store.chunks.get(id)?.every((chunk) => chunk.hasEmbedding)).toBe(true);
  });

  it('requeues a ready document with chunks that have no embedding', async () => {
    const { services, store, addDocument, reindex } = await start();
    const id = addDocument('ready', { chunks: [true, false] });

    const response = await reindex(id);

    expect(response.statusCode).toBe(202);
    await services.ingestion.indexer?.index(id);
    expect(store.documents.get(id)?.status).toBe('ready');
    expect(store.chunks.get(id)?.every((chunk) => chunk.hasEmbedding)).toBe(true);
  });

  it('rejects a ready document whose chunks are all embedded (409 DOCUMENT_ALREADY_INDEXED)', async () => {
    const { addDocument, reindex } = await start();
    const id = addDocument('ready', { chunks: [true, true] });

    const response = await reindex(id);

    expect(response.statusCode).toBe(409);
    expect(response.json<ApiErrorResponse>().error.code).toBe('DOCUMENT_ALREADY_INDEXED');
  });

  it.each(['processing', 'pending'] as const)(
    'rejects a %s document with 409 DOCUMENT_BUSY',
    async (status) => {
      const { store, addDocument, reindex } = await start();
      const id = addDocument(status);

      const response = await reindex(id);

      expect(response.statusCode).toBe(409);
      expect(response.json<ApiErrorResponse>().error).toMatchObject({
        code: 'DOCUMENT_BUSY',
        details: { status },
      });
      expect(store.documents.get(id)?.status).toBe(status);
    },
  );

  it('answers 404 for an unknown document and 400 for a malformed id', async () => {
    const { reindex } = await start();

    const missing = await reindex(UNKNOWN_ID);
    const malformed = await reindex('not-a-uuid');

    expect(missing.statusCode).toBe(404);
    expect(missing.json<ApiErrorResponse>().error.code).toBe('DOCUMENT_NOT_FOUND');
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<ApiErrorResponse>().error.code).toBe('VALIDATION_ERROR');
  });

  it('answers 503 INDEXING_UNAVAILABLE without an indexer and leaves the status unchanged', async () => {
    const { store, addDocument, reindex } = await start({ withIndexer: false });
    const id = addDocument('failed');

    const response = await reindex(id);

    expect(response.statusCode).toBe(503);
    expect(response.json<ApiErrorResponse>().error.code).toBe('INDEXING_UNAVAILABLE');
    expect(store.documents.get(id)?.status).toBe('failed');
  });
});

describe('DocumentsService.reindex', () => {
  it('answers 409 DOCUMENT_BUSY when the status changes between check and update', async () => {
    const store = createInMemoryStore();
    const repository = createInMemoryDocumentsRepository(store);
    const document = fakeDocument({ status: 'failed' });
    store.documents.set(document.id, document);
    const indexed: string[] = [];
    const service = createDocumentsService({
      repository: {
        ...repository,
        // A concurrent request claims the document first.
        requeue: async (id) => {
          store.documents.set(id, { ...document, status: 'processing' });
          return undefined;
        },
      },
      collections: {
        assertExists: async () => undefined,
        get: async () => {
          throw new Error('not used by reindex');
        },
      },
      indexer: { index: async (id) => void indexed.push(id) },
      countMissingEmbeddings: async () => 0,
    });

    await expect(service.reindex(document.id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'DOCUMENT_BUSY',
      details: { status: 'processing' },
    });
    expect(indexed).toEqual([]);
  });
});
