import { describe, expect, it } from 'vitest';
import { createDocumentIndexer } from '../src/modules/ingestion/document-indexer.js';
import { INTERRUPTED_MESSAGE, recoverDocuments } from '../src/modules/ingestion/recovery.js';
import {
  createInMemoryDocumentsRepository,
  createInMemoryStore,
  createRecordingLogger,
  fakeDocument,
} from './fakes.js';

describe('recoverDocuments', () => {
  it('turns processing documents into failed with a hint', async () => {
    const store = createInMemoryStore();
    const processing = fakeDocument({ status: 'processing' });
    const ready = fakeDocument({ status: 'ready' });
    store.documents.set(processing.id, processing);
    store.documents.set(ready.id, ready);

    const result = await recoverDocuments({
      repository: createInMemoryDocumentsRepository(store),
      indexer: undefined,
      logger: createRecordingLogger(),
    });

    expect(result).toEqual({ failed: 1, resumed: 0 });
    expect(store.documents.get(processing.id)).toMatchObject({
      status: 'failed',
      errorMessage: INTERRUPTED_MESSAGE,
    });
    expect(store.documents.get(ready.id)?.status).toBe('ready');
    expect([...store.documents.values()].some((d) => d.status === 'processing')).toBe(false);
  });

  it('re-queues pending documents when an indexer is active', async () => {
    const store = createInMemoryStore();
    const repository = createInMemoryDocumentsRepository(store);
    const pending = { ...fakeDocument({ status: 'pending', chunkCount: 0 }), content: 'x' };
    store.documents.set(pending.id, pending);
    const indexed: string[] = [];
    const indexer = createDocumentIndexer({
      repository,
      steps: [{ name: 'step', run: async (context) => void indexed.push(context.document.id) }],
      logger: createRecordingLogger(),
      concurrency: 1,
    });

    const result = await recoverDocuments({ repository, indexer, logger: createRecordingLogger() });
    await indexer.index(pending.id);

    expect(result).toEqual({ failed: 0, resumed: 1 });
    expect(indexed).toEqual([pending.id]);
    expect(store.documents.get(pending.id)?.status).toBe('ready');
  });

  it('leaves pending documents alone without an indexer', async () => {
    const store = createInMemoryStore();
    const pending = fakeDocument({ status: 'pending' });
    store.documents.set(pending.id, pending);

    const result = await recoverDocuments({
      repository: createInMemoryDocumentsRepository(store),
      indexer: undefined,
      logger: createRecordingLogger(),
    });

    expect(result).toEqual({ failed: 0, resumed: 0 });
    expect(store.documents.get(pending.id)?.status).toBe('pending');
  });

  it('logs and swallows database errors so the API can still start', async () => {
    const logger = createRecordingLogger();
    const repository = createInMemoryDocumentsRepository(createInMemoryStore());

    const result = await recoverDocuments({
      repository: {
        ...repository,
        failInterrupted: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
      indexer: undefined,
      logger,
    });

    expect(result).toEqual({ failed: 0, resumed: 0 });
    expect(logger.entries[0]?.level).toBe('error');
  });
});
