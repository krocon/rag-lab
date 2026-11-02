import type { CollectionDto } from '@raglab/shared';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/http/errors.js';
import { EmbeddingProviderError } from '../../src/modules/embeddings/embedding-provider.js';
import type {
  RetrievalRepository,
  RetrievedChunk,
  VectorSearchParams,
} from '../../src/modules/retrieval/retrieval.repository.js';
import {
  createRetrievalService,
  rankResults,
  toProviderAppError,
} from '../../src/modules/retrieval/retrieval.service.js';
import {
  createFakeEmbeddingProvider,
  modelNotFound,
  type FakeEmbeddingProvider,
} from '../fakes/fake-embedding-provider.js';

const COLLECTION_ID = randomUUID();

function collection(overrides: Partial<CollectionDto> = {}): CollectionDto {
  return {
    id: COLLECTION_ID,
    name: 'Docs',
    description: null,
    embeddingProvider: 'ollama',
    embeddingModel: 'test-embedding-model',
    embeddingDimensions: 768,
    documentCount: 2,
    readyDocumentCount: 2,
    chunkCount: 4,
    createdAt: '2026-11-02T10:00:00.000Z',
    updatedAt: '2026-11-02T10:00:00.000Z',
    ...overrides,
  };
}

function row(distance: number, overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunkId: randomUUID(),
    documentId: 'doc-a',
    filename: 'guide.md',
    chunkIndex: 0,
    content: 'text',
    headingPath: ['Guide'],
    startOffset: 0,
    endOffset: 4,
    distance,
    ...overrides,
  };
}

interface Setup {
  rows?: RetrievedChunk[];
  collection?: CollectionDto;
  provider?: FakeEmbeddingProvider;
  columnDimensions?: number;
}

function setup({
  rows = [],
  collection: stored = collection(),
  provider = createFakeEmbeddingProvider(),
  columnDimensions = 768,
}: Setup = {}) {
  const searches: VectorSearchParams[] = [];
  const repository: RetrievalRepository = {
    search: async (params) => {
      searches.push(params);
      return rows;
    },
  };
  const service = createRetrievalService({
    repository,
    embeddingProvider: provider,
    collections: {
      get: async (id) => {
        if (id !== stored.id) {
          throw new AppError(404, 'COLLECTION_NOT_FOUND', `Collection ${id} does not exist`);
        }
        return stored;
      },
    },
    config: { defaultTopK: 8, maxQueryChars: 50 },
    columnDimensions,
  });
  return { service, searches, provider };
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected a rejection');
}

describe('retrieval service', () => {
  it('embeds the trimmed query and searches the collection with the default topK', async () => {
    const { service, searches, provider } = setup({ rows: [row(0.1)] });

    const response = await service.search({ collectionId: COLLECTION_ID, query: '  how?  ' });

    expect(provider.calls).toEqual([['how?']]);
    expect(searches).toHaveLength(1);
    expect(searches[0]?.collectionId).toBe(COLLECTION_ID);
    expect(searches[0]?.limit).toBe(8);
    expect(searches[0]?.embedding).toHaveLength(768);
    expect(response).toMatchObject({
      collectionId: COLLECTION_ID,
      query: 'how?',
      topK: 8,
      minScore: null,
      embedding: { provider: 'ollama', model: 'test-embedding-model', dimensions: 768 },
    });
    expect(response).not.toHaveProperty('emptyReason');
    expect(response.timings.embeddingMs).toBeGreaterThanOrEqual(0);
    expect(response.timings.searchMs).toBeGreaterThanOrEqual(0);
  });

  it('sorts relaxed_order results by distance and assigns gapless ranks', async () => {
    // relaxed_order may return rows slightly out of order.
    const rows = [row(0.4), row(0.1), row(0.3), row(0.2)];
    const { service } = setup({ rows });

    const { results } = await service.search({ collectionId: COLLECTION_ID, query: 'q', topK: 4 });

    expect(results.map((result) => result.distance)).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(results.map((result) => result.rank)).toEqual([1, 2, 3, 4]);
    expect(results.map((result) => result.score)).toEqual(
      [0.9, 0.8, 0.7, 0.6].map((s) => expect.closeTo(s, 10)),
    );
    for (const result of results) {
      expect(result.score).toBe(1 - result.distance);
    }
  });

  it('breaks distance ties deterministically by document and chunk index', () => {
    const ranked = rankResults([
      row(0.5, { documentId: 'doc-b', chunkIndex: 0 }),
      row(0.5, { documentId: 'doc-a', chunkIndex: 2 }),
      row(0.5, { documentId: 'doc-a', chunkIndex: 1 }),
    ]);
    expect(ranked.map((result) => `${result.documentId}#${result.chunkIndex}`)).toEqual([
      'doc-a#1',
      'doc-a#2',
      'doc-b#0',
    ]);
  });

  it('applies minScore after the search and re-ranks without gaps', async () => {
    const { service } = setup({ rows: [row(0.6), row(0.1), row(0.3)] });

    const response = await service.search({
      collectionId: COLLECTION_ID,
      query: 'q',
      minScore: 0.65,
    });

    expect(response.minScore).toBe(0.65);
    expect(response.results.map((result) => [result.rank, result.distance])).toEqual([
      [1, 0.1],
      [2, 0.3],
    ]);
  });

  it('reports below_min_score when every result is filtered out', async () => {
    const { service } = setup({ rows: [row(0.9), row(1.2)] });

    const response = await service.search({
      collectionId: COLLECTION_ID,
      query: 'q',
      minScore: 0.5,
    });

    expect(response.results).toEqual([]);
    expect(response.emptyReason).toBe('below_min_score');
  });

  it('reports collection_empty without embedding the query', async () => {
    const { service, provider, searches } = setup({
      collection: collection({ documentCount: 0, readyDocumentCount: 0, chunkCount: 0 }),
    });

    const response = await service.search({ collectionId: COLLECTION_ID, query: 'q' });

    expect(response).toMatchObject({
      results: [],
      emptyReason: 'collection_empty',
      timings: { embeddingMs: 0, searchMs: 0 },
    });
    expect(provider.calls).toEqual([]);
    expect(searches).toEqual([]);
  });

  it('reports no_indexed_chunks without ready documents or without search hits', async () => {
    const notReady = setup({ collection: collection({ readyDocumentCount: 0 }) });
    const first = await notReady.service.search({ collectionId: COLLECTION_ID, query: 'q' });
    expect(first).toMatchObject({ results: [], emptyReason: 'no_indexed_chunks' });
    expect(notReady.provider.calls).toEqual([]);

    const noRows = setup({ rows: [] });
    const second = await noRows.service.search({ collectionId: COLLECTION_ID, query: 'q' });
    expect(second).toMatchObject({ results: [], emptyReason: 'no_indexed_chunks' });
    expect(noRows.provider.calls).toHaveLength(1);
  });

  it('refuses a collection embedded with another model (409) before calling the provider', async () => {
    const { service, provider } = setup({
      collection: collection({ embeddingModel: 'old-model' }),
    });

    const error = await rejection(service.search({ collectionId: COLLECTION_ID, query: 'q' }));

    expect(error.statusCode).toBe(409);
    expect(error.code).toBe('EMBEDDING_MODEL_MISMATCH');
    expect(error.details).toMatchObject({
      collectionModel: 'old-model',
      providerModel: 'test-embedding-model',
    });
    expect(provider.calls).toEqual([]);
  });

  it('treats other dimensions or providers as a model mismatch as well', async () => {
    for (const overrides of [{ embeddingDimensions: 1024 }, { embeddingProvider: 'other' }]) {
      const { service } = setup({ collection: collection(overrides) });
      const error = await rejection(service.search({ collectionId: COLLECTION_ID, query: 'q' }));
      expect(error.code).toBe('EMBEDDING_MODEL_MISMATCH');
    }
  });

  it('refuses to search when the configured dimension differs from the column (503)', async () => {
    const { service } = setup({ columnDimensions: 1024 });
    const error = await rejection(service.search({ collectionId: COLLECTION_ID, query: 'q' }));
    expect(error.statusCode).toBe(503);
    expect(error.code).toBe('EMBEDDING_DIMENSION_MISMATCH');
  });

  it('propagates 404 for unknown collections', async () => {
    const { service } = setup();
    const error = await rejection(service.search({ collectionId: randomUUID(), query: 'q' }));
    expect(error.code).toBe('COLLECTION_NOT_FOUND');
  });

  it.each([
    [{ query: '   ' }, 'body/query'],
    [{ query: 'x'.repeat(51) }, 'body/query'],
    [{ query: 'q', topK: 0 }, 'body/topK'],
    [{ query: 'q', topK: 101 }, 'body/topK'],
    [{ query: 'q', topK: 2.5 }, 'body/topK'],
    [{ query: 'q', minScore: 1.5 }, 'body/minScore'],
    [{ query: 'q', minScore: -1.01 }, 'body/minScore'],
    [{ query: 'q', minScore: Number.NaN }, 'body/minScore'],
  ])('rejects invalid input %j with 400 VALIDATION_ERROR', async (input, location) => {
    const { service, provider } = setup();
    const error = await rejection(service.search({ collectionId: COLLECTION_ID, ...input }));
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toEqual([expect.objectContaining({ location })]);
    expect(provider.calls).toEqual([]);
  });

  it('accepts the boundaries of topK, minScore and the query length', async () => {
    const { service } = setup({ rows: [row(0)] });
    await expect(
      service.search({
        collectionId: COLLECTION_ID,
        query: 'x'.repeat(50),
        topK: 100,
        minScore: -1,
      }),
    ).resolves.toMatchObject({ topK: 100, minScore: -1 });
    await expect(
      service.search({ collectionId: COLLECTION_ID, query: 'q', topK: 1, minScore: 1 }),
    ).resolves.toMatchObject({ topK: 1, minScore: 1, results: [{ score: 1 }] });
  });

  it.each([
    ['PROVIDER_UNREACHABLE', 503, 'EMBEDDING_PROVIDER_UNAVAILABLE'],
    ['PROVIDER_TIMEOUT', 503, 'EMBEDDING_PROVIDER_UNAVAILABLE'],
    ['MODEL_NOT_FOUND', 502, 'EMBEDDING_PROVIDER_ERROR'],
    ['DIMENSION_MISMATCH', 502, 'EMBEDDING_PROVIDER_ERROR'],
    ['PROVIDER_ERROR', 502, 'EMBEDDING_PROVIDER_ERROR'],
  ] as const)('maps provider error %s to %i %s', async (providerCode, status, code) => {
    const provider = createFakeEmbeddingProvider({
      failWith: new EmbeddingProviderError(providerCode, 'Provider failed.', { hint: 'Fix it.' }),
    });
    const { service, searches } = setup({ provider });

    const error = await rejection(
      service.search({ collectionId: COLLECTION_ID, query: 'secret question' }),
    );

    expect(error.statusCode).toBe(status);
    expect(error.code).toBe(code);
    expect(error.details).toEqual({ providerCode, hint: 'Fix it.' });
    expect(error.message).not.toContain('secret question');
    expect(searches).toEqual([]);
  });

  it('keeps the provider hint of a missing model', () => {
    const error = toProviderAppError(modelNotFound());
    expect(error.details).toEqual({
      providerCode: 'MODEL_NOT_FOUND',
      hint: 'Run "ollama pull test-embedding-model" on the Ollama host.',
    });
  });

  it('rejects provider answers with the wrong dimension (502)', async () => {
    const provider = createFakeEmbeddingProvider({ outputDimensions: 3 });
    const { service } = setup({ provider });
    const error = await rejection(service.search({ collectionId: COLLECTION_ID, query: 'q' }));
    expect(error.statusCode).toBe(502);
    expect(error.details).toMatchObject({ providerCode: 'DIMENSION_MISMATCH' });
  });

  it('rejects with the abort reason when the signal aborts', async () => {
    const { service, searches } = setup({ rows: [row(0.1)] });
    const controller = new AbortController();
    const reason = new Error('client closed the request');
    controller.abort(reason);

    await expect(
      service.search({ collectionId: COLLECTION_ID, query: 'q' }, controller.signal),
    ).rejects.toBe(reason);
    expect(searches).toEqual([]);
  });
});
