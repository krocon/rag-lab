import { loggableError } from '../../http/errors.js';

/** The data an indexing step works on (loaded when the document is claimed for processing). */
export interface IndexingDocument {
  id: string;
  collectionId: string;
  filename: string;
  /** Relative path within the imported source; `null` for uploads without a path. */
  path: string | null;
  mimeType: string;
  /** Normalised text (see `normalizeText`). */
  content: string;
}

/** Shared state of one indexing run, passed through all steps in order. */
export interface IndexingContext {
  readonly document: IndexingDocument;
  /** Number of chunks stored for the document; set by the chunking step (prompt 005). */
  chunkCount: number;
}

/**
 * One step of the indexing pipeline (chunking: 005, embedding: 006). Steps must honour `signal`
 * (abort on shutdown) and throw on failure; an {@link IndexingError} carries a message for users.
 */
export interface IndexingStep {
  readonly name: string;
  run(context: IndexingContext, signal: AbortSignal): Promise<void>;
}

/**
 * Failure with a message that is safe and meaningful for users (stored in
 * `documents.error_message`). Any other error is reported with a generic message; its details go
 * to the log only.
 */
export class IndexingError extends Error {
  constructor(userMessage: string, options?: { cause?: unknown }) {
    super(userMessage, options);
    this.name = 'IndexingError';
  }
}

/** Status transitions the indexer needs; implemented by the documents repository. */
export interface DocumentIndexingRepository {
  /**
   * Atomically moves a `pending` (or `failed`, for retries) document to `processing` and returns
   * it, or `undefined` if it does not exist (anymore) or is in another state.
   */
  claimForProcessing(id: string): Promise<IndexingDocument | undefined>;
  /** `processing → ready`; no-op if the document is gone or no longer `processing`. */
  markReady(id: string, chunkCount: number): Promise<void>;
  /** `processing → failed`; no-op if the document is gone or no longer `processing`. */
  markFailed(id: string, errorMessage: string): Promise<void>;
}

/** Minimal logger interface (satisfied by pino / Fastify's logger). */
export interface IndexerLogger {
  info(object: object, message: string): void;
  warn(object: object, message: string): void;
  error(object: object, message: string): void;
}

export interface DocumentIndexer {
  /**
   * Queues a document for indexing. The returned promise settles when the run has finished and
   * never rejects; request handlers do not await it.
   * Documents already queued or running are not queued twice.
   */
  index(documentId: string): Promise<void>;
  /**
   * Stops the indexer: queued documents are dropped (they stay `pending`), running ones are
   * aborted via `AbortSignal` and marked `failed`. Resolves when every running job has settled.
   */
  close(): Promise<void>;
}

export interface DocumentIndexerDependencies {
  repository: DocumentIndexingRepository;
  steps: readonly IndexingStep[];
  logger: IndexerLogger;
  /** Maximum number of documents processed at the same time (`INGESTION_CONCURRENCY`). */
  concurrency: number;
}

export const SHUTDOWN_MESSAGE =
  'Processing was interrupted because the server shut down. Reindex the document to try again.';

export function genericStepFailureMessage(step: string): string {
  return `Processing failed in step "${step}". See the server log for details.`;
}

/**
 * Creates the in-process indexer (docs/architecture.md §4.1): bounded concurrency, statuses
 * `pending → processing → ready | failed`, abort on shutdown. Requires at least one step – an
 * indexer without steps would mark documents `ready` without chunks.
 */
export function createDocumentIndexer({
  repository,
  steps,
  logger,
  concurrency,
}: DocumentIndexerDependencies): DocumentIndexer {
  if (steps.length === 0) {
    throw new Error('createDocumentIndexer needs at least one indexing step');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('createDocumentIndexer needs a concurrency of at least 1');
  }

  const shutdown = new AbortController();
  const queue: { documentId: string; done: () => void }[] = [];
  const scheduled = new Map<string, Promise<void>>();
  const running = new Set<Promise<void>>();

  async function run(documentId: string): Promise<void> {
    const document = await repository.claimForProcessing(documentId);
    if (!document) {
      logger.info({ documentId }, 'document not indexed: missing or not pending');
      return;
    }
    const context: IndexingContext = { document, chunkCount: 0 };
    const startedAt = Date.now();
    let currentStep = '';
    try {
      for (const step of steps) {
        currentStep = step.name;
        shutdown.signal.throwIfAborted();
        await step.run(context, shutdown.signal);
      }
      shutdown.signal.throwIfAborted();
      await repository.markReady(documentId, context.chunkCount);
      logger.info(
        { documentId, chunkCount: context.chunkCount, durationMs: Date.now() - startedAt },
        'document indexed',
      );
    } catch (error) {
      const aborted = shutdown.signal.aborted;
      const message = aborted
        ? SHUTDOWN_MESSAGE
        : error instanceof IndexingError
          ? error.message
          : genericStepFailureMessage(currentStep);
      // Only ids, step name and the error itself – never document content.
      logger[aborted ? 'warn' : 'error'](
        { documentId, step: currentStep, err: loggableError(error) },
        aborted ? 'document indexing aborted' : 'document indexing failed',
      );
      await repository.markFailed(documentId, message);
    }
  }

  function startJob(documentId: string, done: () => void): void {
    const job = run(documentId)
      .catch((error: unknown) => {
        // Claiming or a status update failed (e.g. database down). The document stays in its
        // current state; recovery at the next start turns a stuck `processing` into `failed`.
        logger.error({ documentId, err: loggableError(error) }, 'document indexing crashed');
      })
      .finally(() => {
        running.delete(job);
        scheduled.delete(documentId);
        done();
        drain();
      });
    running.add(job);
  }

  function drain(): void {
    while (!shutdown.signal.aborted && running.size < concurrency && queue.length > 0) {
      const next = queue.shift();
      if (next) {
        startJob(next.documentId, next.done);
      }
    }
  }

  return {
    index(documentId) {
      if (shutdown.signal.aborted) {
        return Promise.resolve();
      }
      const existing = scheduled.get(documentId);
      if (existing) {
        return existing;
      }
      const settled = new Promise<void>((resolve) => {
        queue.push({ documentId, done: resolve });
      });
      scheduled.set(documentId, settled);
      drain();
      return settled;
    },

    async close() {
      if (!shutdown.signal.aborted) {
        shutdown.abort(new Error('indexer closed'));
      }
      for (const dropped of queue.splice(0)) {
        scheduled.delete(dropped.documentId);
        dropped.done();
      }
      await Promise.allSettled([...running]);
    },
  };
}
