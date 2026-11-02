import { describe, expect, it } from 'vitest';
import { parseDataset, type EvalDataset } from '../../src/eval/dataset.js';
import { EvalError, runEvaluation } from '../../src/eval/evaluate.js';
import { createLexicalEmbeddingProvider } from '../../src/eval/lexical-embedding-provider.js';
import type { EmbeddingProvider } from '../../src/modules/embeddings/embedding-provider.js';
import { createCollectionsService } from '../../src/modules/collections/collections.service.js';
import { createIndexingSteps } from '../../src/services.js';
import {
  createInMemoryChunksRepository,
  createInMemoryCollectionsRepository,
  createInMemoryServices,
  createInMemoryStore,
} from '../fakes.js';
import { modelNotFound } from '../fakes/fake-embedding-provider.js';
import { testConfig } from '../helpers.js';

/** Runs the real evaluation flow on in-memory repositories (no database). */
const DATASET: EvalDataset = parseDataset(
  'mini',
  [
    {
      filename: 'bread.md',
      raw: '# Bread\n\n## Starter\n\nFeed the sourdough starter flour and water every day.\n\n## Baking\n\nBake the loaf in a hot Dutch oven.\n',
    },
    { filename: 'bikes.txt', raw: 'Check the tyre pressure of the bicycle every week.\n' },
    {
      filename: 'coffee.md',
      raw: '# Coffee\n\nGrind the beans finer when espresso tastes sour.\n',
    },
  ],
  [
    {
      id: 'q1',
      query: 'feeding a sourdough starter',
      relevant: [{ document: 'bread.md', heading: 'Starter' }],
    },
    { id: 'q2', query: 'bicycle tyre pressure', relevant: [{ document: 'bikes.txt' }] },
    {
      id: 'q3',
      query: 'sour espresso grind',
      relevant: [{ document: 'coffee.md', marker: 'Grind the beans finer' }],
    },
  ]
    .map((query) => JSON.stringify(query))
    .join('\n'),
);

function setup(provider: EmbeddingProvider = lexical()) {
  const config = testConfig({ CHUNK_SIZE: '200', CHUNK_OVERLAP: '0' });
  const store = createInMemoryStore();
  const collections = createCollectionsService({
    repository: createInMemoryCollectionsRepository(store),
    embedding: config.embedding,
  });
  const steps = createIndexingSteps({
    chunks: createInMemoryChunksRepository(store),
    collections,
    embeddingProvider: provider,
    config,
  });
  const services = createInMemoryServices(config, store, { steps, embeddingProvider: provider });
  return { services, store };
}

/** The lexical baseline under the id/model of the test configuration. */
function lexical(): EmbeddingProvider {
  return { ...createLexicalEmbeddingProvider(768), id: 'ollama', model: 'test-embedding-model' };
}

describe('runEvaluation (in-memory services)', () => {
  it('indexes through the real services, scores every query and deletes the collection', async () => {
    const { services, store } = setup();
    const progress: string[] = [];

    const run = await runEvaluation({
      services,
      dataset: DATASET,
      collectionName: 'eval-mini',
      ks: [3, 1, 3],
      onProgress: (message) => progress.push(message),
    });

    expect(run.ks).toEqual([1, 3]);
    expect(run.topK).toBe(3);
    expect(run.kept).toBe(false);
    expect(run.indexing).toMatchObject({ documents: 3, chunks: 4 });
    expect(run.unresolvedAnchors).toEqual([]);
    expect(run.queries.map((query) => query.results[0]?.filename)).toEqual([
      'bread.md',
      'bikes.txt',
      'coffee.md',
    ]);
    expect(run.queries[0]?.results[0]).toMatchObject({
      rank: 1,
      headingPath: ['Bread', 'Starter'],
      documentRelevant: true,
      matchedAnchors: ['bread.md#Starter'],
    });
    expect(run.summary.document.atK['1']).toEqual({ recall: 1, precision: 1, hitRate: 1 });
    expect(run.summary.section.mrr).toBe(1);
    expect(progress).toHaveLength(2);
    expect(store.collections.size).toBe(0);
  });

  it('keeps the collection with keep: true', async () => {
    const { services, store } = setup();
    const run = await runEvaluation({
      services,
      dataset: DATASET,
      collectionName: 'eval-keep',
      keep: true,
    });
    expect(run.kept).toBe(true);
    expect(store.collections.has(run.collectionId)).toBe(true);
  });

  it('fails with a readable message when indexing fails and still deletes the collection', async () => {
    const failing = { ...lexical(), embed: async () => Promise.reject(modelNotFound()) };
    const { services, store } = setup(failing);
    await expect(
      runEvaluation({ services, dataset: DATASET, collectionName: 'eval-fail' }),
    ).rejects.toThrow(EvalError);
    expect(store.collections.size).toBe(0);
  });

  it('stops on abort and deletes the collection', async () => {
    const { services, store } = setup();
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(
      runEvaluation({
        services,
        dataset: DATASET,
        collectionName: 'eval-abort',
        signal: controller.signal,
      }),
    ).rejects.toThrow('stop');
    expect(store.collections.size).toBe(0);
  });

  it('requires at least one K', async () => {
    const { services } = setup();
    await expect(
      runEvaluation({ services, dataset: DATASET, collectionName: 'x', ks: [] }),
    ).rejects.toThrow(/At least one K/);
  });
});
