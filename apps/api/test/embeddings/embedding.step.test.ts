import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ChunkDraft } from '../../src/modules/chunking/chunker.js';
import { createChunkingStep } from '../../src/modules/chunking/chunking.step.js';
import { createCollectionsService } from '../../src/modules/collections/collections.service.js';
import {
  createEmbeddingStep,
  EMBEDDING_STEP_NAME,
} from '../../src/modules/embeddings/embedding.step.js';
import { EmbeddingProviderError } from '../../src/modules/embeddings/embedding-provider.js';
import {
  createDocumentIndexer,
  genericStepFailureMessage,
  IndexingError,
  type IndexingContext,
  type IndexingStep,
} from '../../src/modules/ingestion/document-indexer.js';
import {
  createInMemoryChunksRepository,
  createInMemoryCollectionsRepository,
  createInMemoryDocumentsRepository,
  createInMemoryStore,
  createRecordingLogger,
  fakeDocument,
  type InMemoryStore,
} from '../fakes.js';
import {
  createFakeEmbeddingProvider,
  fakeVector,
  modelNotFound,
  type FakeEmbeddingProvider,
} from '../fakes/fake-embedding-provider.js';
import { testConfig } from '../helpers.js';

const config = testConfig();

function draft(index: number, content = `chunk ${index}`): ChunkDraft {
  return {
    chunkIndex: index,
    content,
    startOffset: index,
    endOffset: index + 1,
    charCount: content.length,
    tokenEstimate: 2,
    headingPath: [],
    overlapChars: 0,
    startLine: 1,
    endLine: 1,
    symbol: null,
  };
}

async function setup({
  provider = createFakeEmbeddingProvider(),
  columnDimensions = 768,
  chunkCount = 3,
}: {
  provider?: FakeEmbeddingProvider;
  columnDimensions?: number;
  chunkCount?: number;
} = {}) {
  const store: InMemoryStore = createInMemoryStore();
  const collections = createCollectionsService({
    repository: createInMemoryCollectionsRepository(store),
    embedding: config.embedding,
  });
  const collection = await collections.create({ name: 'Docs' });
  const chunks = createInMemoryChunksRepository(store);
  const document = { id: randomUUID(), collectionId: collection.id };
  await chunks.replaceForDocument(
    document,
    Array.from({ length: chunkCount }, (_, index) => draft(index)),
  );
  const step = createEmbeddingStep({ provider, chunks, collections, columnDimensions });
  const context: IndexingContext = {
    document: { ...document, filename: 'a.md', path: null, mimeType: 'text/markdown', content: 'x' },
    chunkCount,
  };
  return { store, collections, collection, chunks, document, step, context, provider };
}

const run = (
  step: IndexingStep,
  context: IndexingContext,
  signal = new AbortController().signal,
): Promise<void> => step.run(context, signal);

async function runError(promise: Promise<void>): Promise<IndexingError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(IndexingError);
  return error as IndexingError;
}

describe('embedding step', () => {
  it('embeds imported documents with a context header (path, symbol), content unchanged', async () => {
    const { step, context, store, document, provider } = await setup({ chunkCount: 1 });
    const [chunk] = store.chunks.get(document.id) ?? [];
    if (chunk) {
      chunk.metadata = { ...chunk.metadata, symbol: 'class Tree' };
    }

    await run(step, { ...context, document: { ...context.document, path: 'src/tree.ts' } });

    expect(provider.calls).toEqual([['File: src/tree.ts\nSymbol: class Tree\n\nchunk 0']]);
    expect(store.chunks.get(document.id)?.[0]?.content).toBe('chunk 0');
  });

  it('embeds all chunks without a vector and stores the vectors', async () => {
    const { step, context, store, document, provider } = await setup();

    await run(step, context);

    expect(step.name).toBe(EMBEDDING_STEP_NAME);
    expect(provider.calls).toEqual([['chunk 0', 'chunk 1', 'chunk 2']]);
    const stored = store.chunks.get(document.id) ?? [];
    expect(stored.every((chunk) => chunk.hasEmbedding)).toBe(true);
    expect(stored.map((chunk) => store.embeddings.get(chunk.id))).toEqual(
      ['chunk 0', 'chunk 1', 'chunk 2'].map((text) => fakeVector(text, 768)),
    );
  });

  it('embeds only chunks that have no vector yet', async () => {
    const { step, context, store, document, provider, chunks } = await setup();
    const [first] = store.chunks.get(document.id) ?? [];
    await chunks.storeEmbeddings(document.id, [
      { chunkId: first?.id ?? '', embedding: fakeVector('x', 768) },
    ]);

    await run(step, context);

    expect(provider.calls).toEqual([['chunk 1', 'chunk 2']]);
  });

  it('does not call the provider when every chunk is embedded already', async () => {
    const { step, context, provider } = await setup({ chunkCount: 0 });

    await run(step, context);

    expect(provider.calls).toEqual([]);
  });

  it.each([
    ['model', { model: 'other-model' }, '"other-model" (ollama, 768 dimensions)'],
    ['provider', { id: 'other-provider' }, '(other-provider, 768 dimensions)'],
  ])(
    'refuses to embed when the collection uses another %s (EMBEDDING_MODEL_MISMATCH)',
    async (_label, override, expectedText) => {
      const { step, context, store, document, provider } = await setup({
        provider: createFakeEmbeddingProvider(override),
      });

      const error = await runError(run(step, context));

      expect(error.message).toMatch(/^EMBEDDING_MODEL_MISMATCH: /);
      expect(error.message).toContain('"test-embedding-model" (ollama, 768 dimensions)');
      expect(error.message).toContain(expectedText);
      expect(provider.calls).toEqual([]);
      expect((store.chunks.get(document.id) ?? []).some((chunk) => chunk.hasEmbedding)).toBe(false);
    },
  );

  it('refuses to embed when the collection has another dimension', async () => {
    const { step, context, collection, store } = await setup();
    const stored = store.collections.get(collection.id);
    if (stored) {
      stored.embeddingDimensions = 1024;
    }

    const error = await runError(run(step, context));

    expect(error.message).toMatch(/^EMBEDDING_MODEL_MISMATCH: .*1024 dimensions/);
  });

  it('refuses to embed when the configured dimension differs from the database column', async () => {
    const provider = createFakeEmbeddingProvider();
    const { step, context } = await setup({ provider, columnDimensions: 1024 });

    const error = await runError(run(step, context));

    expect(error.message).toContain('chunks.embedding has 1024 dimensions');
    expect(provider.calls).toEqual([]);
  });

  it('never stores vectors with the wrong length', async () => {
    const { step, context, store, document } = await setup({
      provider: createFakeEmbeddingProvider({ outputDimensions: 767 }),
    });

    const error = await runError(run(step, context));

    expect(error.message).toContain('767 dimensions');
    expect(error.cause).toMatchObject({ code: 'DIMENSION_MISMATCH' });
    expect(store.embeddings.size).toBe(0);
    expect((store.chunks.get(document.id) ?? []).some((chunk) => chunk.hasEmbedding)).toBe(false);
  });

  it('rejects a wrong vector count from an adapter before storing anything', async () => {
    const provider = createFakeEmbeddingProvider();
    provider.embed = async () => [fakeVector('only one', 768)];
    const { step, context, store } = await setup({ provider });

    const error = await runError(run(step, context));

    expect(error.cause).toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(store.embeddings.size).toBe(0);
  });

  it('turns provider errors into a user message with the hint', async () => {
    const provider = createFakeEmbeddingProvider({ failWith: modelNotFound() });
    const { step, context } = await setup({ provider });

    const error = await runError(run(step, context));

    expect(error.message).toBe(
      'Embedding failed: Embedding model "test-embedding-model" is not installed. ' +
        'Run "ollama pull test-embedding-model" on the Ollama host. Then reindex the document.',
    );
  });

  it('rethrows unexpected errors unchanged (generic message via the indexer)', async () => {
    const failure = new Error('boom');
    const { step, context } = await setup({
      provider: createFakeEmbeddingProvider({ failWith: failure }),
    });

    await expect(run(step, context)).rejects.toBe(failure);
  });

  it('honours an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('shutdown'));
    const { step, context, store } = await setup();

    await expect(run(step, context, controller.signal)).rejects.toThrow('shutdown');
    expect(store.embeddings.size).toBe(0);
  });
});

describe('indexer with chunking and embedding', () => {
  async function pipeline(provider: FakeEmbeddingProvider) {
    const store = createInMemoryStore();
    const collections = createCollectionsService({
      repository: createInMemoryCollectionsRepository(store),
      embedding: config.embedding,
    });
    const collection = await collections.create({ name: 'Docs' });
    const chunks = createInMemoryChunksRepository(store);
    const logger = createRecordingLogger();
    const indexer = createDocumentIndexer({
      repository: createInMemoryDocumentsRepository(store),
      steps: [
        createChunkingStep({ repository: chunks, options: { targetSize: 50, overlap: 0 } }),
        createEmbeddingStep({ provider, chunks, collections, columnDimensions: 768 }),
      ],
      logger,
      concurrency: 1,
    });
    const document = {
      ...fakeDocument({ collectionId: collection.id, status: 'pending', chunkCount: 0 }),
      content: '# Title\n\nFirst paragraph of the text.\n\nSecond paragraph of the text.',
    };
    store.documents.set(document.id, document);
    return { store, indexer, document, logger };
  }

  it('marks the document ready only after every chunk has an embedding', async () => {
    const { store, indexer, document } = await pipeline(createFakeEmbeddingProvider());

    await indexer.index(document.id);

    const stored = store.chunks.get(document.id) ?? [];
    expect(store.documents.get(document.id)).toMatchObject({
      status: 'ready',
      chunkCount: stored.length,
      errorMessage: null,
    });
    expect(stored.length).toBeGreaterThan(1);
    expect(stored.every((chunk) => chunk.hasEmbedding)).toBe(true);
  });

  it('marks the document failed when the provider fails and recovers on the next run', async () => {
    const provider = createFakeEmbeddingProvider({
      failWith: new EmbeddingProviderError('PROVIDER_UNREACHABLE', 'Ollama is not reachable.', {
        hint: 'Start it.',
      }),
    });
    const { store, indexer, document, logger } = await pipeline(provider);

    await indexer.index(document.id);

    expect(store.documents.get(document.id)).toMatchObject({
      status: 'failed',
      errorMessage:
        'Embedding failed: Ollama is not reachable. Start it. Then reindex the document.',
    });
    expect(JSON.stringify(logger.entries)).not.toContain('First paragraph');

    provider.failWith = undefined;
    await indexer.index(document.id);

    expect(store.documents.get(document.id)).toMatchObject({ status: 'ready', errorMessage: null });
  });

  it('reports an unexpected step error generically', async () => {
    const { store, indexer, document } = await pipeline(
      createFakeEmbeddingProvider({ failWith: new Error('boom') }),
    );

    await indexer.index(document.id);

    expect(store.documents.get(document.id)).toMatchObject({
      status: 'failed',
      errorMessage: genericStepFailureMessage('embedding'),
    });
  });
});
