import { describe, expect, it } from 'vitest';
import {
  createDocumentIndexer,
  genericStepFailureMessage,
  IndexingError,
  SHUTDOWN_MESSAGE,
  type IndexingStep,
} from '../src/modules/ingestion/document-indexer.js';
import {
  createInMemoryDocumentsRepository,
  createInMemoryStore,
  createRecordingLogger,
  fakeDocument,
  type InMemoryStore,
} from './fakes.js';

const SECRET_CONTENT = 'TOP SECRET DOCUMENT BODY';

function setup(steps: IndexingStep[], concurrency = 2) {
  const store = createInMemoryStore();
  const logger = createRecordingLogger();
  const indexer = createDocumentIndexer({
    repository: createInMemoryDocumentsRepository(store),
    steps,
    logger,
    concurrency,
  });
  return { store, logger, indexer };
}

function addPending(store: InMemoryStore, overrides = {}) {
  const document = {
    ...fakeDocument({ status: 'pending', chunkCount: 0, ...overrides }),
    content: SECRET_CONTENT,
  };
  store.documents.set(document.id, document);
  return document.id;
}

/** A step whose runs can be released one by one. */
function gatedStep(name = 'gated') {
  const releases: (() => void)[] = [];
  let active = 0;
  let maxActive = 0;
  const step: IndexingStep = {
    name,
    run: (_context, signal) =>
      new Promise<void>((resolve, reject) => {
        active++;
        maxActive = Math.max(maxActive, active);
        const finish = (fn: () => void) => {
          active--;
          fn();
        };
        releases.push(() => finish(resolve));
        signal.addEventListener('abort', () => finish(() => reject(signal.reason)), {
          once: true,
        });
      }),
  };
  return {
    step,
    releaseAll: () => releases.splice(0).forEach((release) => release()),
    get started() {
      return releases.length;
    },
    get maxActive() {
      return maxActive;
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createDocumentIndexer', () => {
  it('requires at least one step', () => {
    expect(() =>
      createDocumentIndexer({
        repository: createInMemoryDocumentsRepository(createInMemoryStore()),
        steps: [],
        logger: createRecordingLogger(),
        concurrency: 1,
      }),
    ).toThrowError(/at least one/);
  });

  it('runs all steps in order and marks the document ready with the chunk count', async () => {
    const calls: string[] = [];
    const statusesSeen: string[] = [];
    const { store, indexer } = setup([
      {
        name: 'first',
        run: async (context) => {
          calls.push('first');
          statusesSeen.push(store.documents.get(context.document.id)?.status ?? '');
          expect(context.document.content).toBe(SECRET_CONTENT);
        },
      },
      {
        name: 'second',
        run: async (context) => {
          calls.push('second');
          context.chunkCount = 7;
        },
      },
    ]);
    const id = addPending(store);

    await indexer.index(id);

    expect(calls).toEqual(['first', 'second']);
    expect(statusesSeen).toEqual(['processing']);
    expect(store.documents.get(id)).toMatchObject({
      status: 'ready',
      chunkCount: 7,
      errorMessage: null,
    });
  });

  it('marks the document failed with a generic message and logs without content', async () => {
    const { store, logger, indexer } = setup([
      {
        name: 'chunking',
        run: async () => {
          throw new Error(`boom while reading ${SECRET_CONTENT.slice(0, 3)}`);
        },
      },
    ]);
    const id = addPending(store);

    await indexer.index(id);

    const document = store.documents.get(id);
    expect(document?.status).toBe('failed');
    expect(document?.errorMessage).toBe(genericStepFailureMessage('chunking'));
    expect(document?.errorMessage).not.toMatch(/at .*\.ts|Error:/);
    const failure = logger.entries.find((entry) => entry.level === 'error');
    expect(failure?.object).toMatchObject({ documentId: id, step: 'chunking' });
    expect(JSON.stringify(logger.entries)).not.toContain(SECRET_CONTENT);
  });

  it('uses the message of an IndexingError for users', async () => {
    const { store, indexer } = setup([
      {
        name: 'embedding',
        run: async () => {
          throw new IndexingError('The embedding provider is not reachable.');
        },
      },
    ]);
    const id = addPending(store);

    await indexer.index(id);

    expect(store.documents.get(id)).toMatchObject({
      status: 'failed',
      errorMessage: 'The embedding provider is not reachable.',
    });
  });

  it('skips documents that are missing or not pending', async () => {
    const ran: string[] = [];
    const { store, indexer } = setup([
      { name: 'step', run: async (context) => void ran.push(context.document.id) },
    ]);
    const ready = addPending(store, { status: 'ready' });

    await indexer.index(ready);
    await indexer.index('0195f2a0-0000-7000-8000-000000000000');

    expect(ran).toEqual([]);
    expect(store.documents.get(ready)?.status).toBe('ready');
  });

  it('limits concurrency and processes queued documents afterwards', async () => {
    const gate = gatedStep();
    const { store, indexer } = setup([gate.step], 2);
    const ids = [addPending(store), addPending(store), addPending(store), addPending(store)];

    const runs = ids.map((id) => indexer.index(id));
    await tick();
    expect(gate.started).toBe(2);

    while (ids.some((id) => store.documents.get(id)?.status !== 'ready')) {
      gate.releaseAll();
      await tick();
    }
    await Promise.all(runs);

    expect(gate.maxActive).toBe(2);
  });

  it('does not queue the same document twice', async () => {
    let runs = 0;
    const { store, indexer } = setup([{ name: 'count', run: async () => void runs++ }]);
    const id = addPending(store);

    await Promise.all([indexer.index(id), indexer.index(id)]);

    expect(runs).toBe(1);
  });

  it('aborts running jobs on close, marks them failed and drops queued ones', async () => {
    const gate = gatedStep('slow');
    const { store, indexer } = setup([gate.step], 1);
    const running = addPending(store);
    const queued = addPending(store);

    const runs = [indexer.index(running), indexer.index(queued)];
    await tick();
    expect(gate.started).toBe(1);

    await indexer.close();
    await Promise.all(runs);

    expect(store.documents.get(running)).toMatchObject({
      status: 'failed',
      errorMessage: SHUTDOWN_MESSAGE,
    });
    expect(store.documents.get(queued)?.status).toBe('pending');

    // Closed indexers accept nothing new.
    await indexer.index(queued);
    expect(store.documents.get(queued)?.status).toBe('pending');
  });

  it('survives repository failures (document stays as is, error is logged)', async () => {
    const store = createInMemoryStore();
    const logger = createRecordingLogger();
    const repository = createInMemoryDocumentsRepository(store);
    const indexer = createDocumentIndexer({
      repository: {
        ...repository,
        claimForProcessing: async () => {
          throw new Error('connection refused');
        },
      },
      steps: [{ name: 'step', run: async () => undefined }],
      logger,
      concurrency: 1,
    });
    const id = addPending(store);

    await expect(indexer.index(id)).resolves.toBeUndefined();

    expect(store.documents.get(id)?.status).toBe('pending');
    expect(logger.entries.some((entry) => entry.message === 'document indexing crashed')).toBe(
      true,
    );
  });
});
