import { loggableError } from '../../http/errors.js';
import type { DocumentIndexer, IndexerLogger } from './document-indexer.js';

export const INTERRUPTED_MESSAGE =
  'Processing was interrupted by a server restart. Reindex the document to try again.';

export interface RecoveryRepository {
  /** Sets every `processing` document to `failed` with the given message; returns the count. */
  failInterrupted(errorMessage: string): Promise<number>;
  /** Ids of all `pending` documents, oldest first. */
  listPendingIds(): Promise<string[]>;
}

export interface RecoveryResult {
  /** Documents that were `processing` and are now `failed`. */
  failed: number;
  /** `pending` documents queued again (0 while no indexer runs). */
  resumed: number;
}

/**
 * Runs once at startup, before the server accepts requests. Without a persistent job queue a
 * document left in `processing` by a crash or restart would hang forever, so it becomes `failed`
 * with {@link INTERRUPTED_MESSAGE}. If an indexer is active, `pending` documents (queued but not
 * started before the restart) are queued again.
 *
 * A database error is logged and not rethrown: the API still starts (readiness reports the
 * database problem), and recovery runs again at the next start.
 */
export async function recoverDocuments({
  repository,
  indexer,
  logger,
}: {
  repository: RecoveryRepository;
  indexer: DocumentIndexer | undefined;
  logger: IndexerLogger;
}): Promise<RecoveryResult> {
  try {
    const failed = await repository.failInterrupted(INTERRUPTED_MESSAGE);
    let resumed = 0;
    if (indexer) {
      const pendingIds = await repository.listPendingIds();
      for (const documentId of pendingIds) {
        void indexer.index(documentId);
      }
      resumed = pendingIds.length;
    }
    if (failed > 0 || resumed > 0) {
      logger.warn({ failed, resumed }, 'recovered documents after restart');
    }
    return { failed, resumed };
  } catch (error) {
    logger.error({ err: loggableError(error) }, 'document recovery failed; retried at next start');
    return { failed: 0, resumed: 0 };
  }
}
