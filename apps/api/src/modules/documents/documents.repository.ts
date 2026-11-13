import { and, asc, count, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  documents,
  type Document,
  type DocumentStatus,
  type NewDocument,
} from '../../db/schema.js';
import type {
  DocumentIndexingRepository,
  IndexingDocument,
} from '../ingestion/document-indexer.js';
import type { RecoveryRepository } from '../ingestion/recovery.js';

/** Document metadata without the (potentially large) normalised `content`. */
export type DocumentMetadata = Omit<Document, 'content'>;

/** Name of the unique index that enforces "same content only once per collection". */
export const DOCUMENT_CONTENT_UNIQUE_INDEX = 'documents_collection_id_content_sha256_unique';

/** Name of the unique index that enforces "one document per path and collection". */
export const DOCUMENT_PATH_UNIQUE_INDEX = 'documents_collection_id_path_unique';

/** Filter and page of {@link DocumentsRepository.listByCollection}. */
export interface DocumentListFilter {
  /** Only documents whose path starts with this prefix (case-sensitive, literal). */
  pathPrefix?: string | undefined;
  /** Page size; `undefined` = all. */
  limit?: number | undefined;
  offset?: number | undefined;
}

/** Fields of a new document; status (`pending`), counters and timestamps use DB defaults. */
export type NewDocumentRecord = Pick<
  NewDocument,
  | 'collectionId'
  | 'filename'
  | 'path'
  | 'mimeType'
  | 'sizeBytes'
  | 'contentSha256'
  | 'content'
  | 'metadata'
>;

export interface ExistingDocumentRef {
  id: string;
  contentSha256: string;
  path: string | null;
  status: DocumentStatus;
}

/**
 * Data access for the `documents` table. The status transitions used by the indexer
 * (`DocumentIndexingRepository`) and the startup recovery (`RecoveryRepository`) live here as
 * well, because this module owns the table.
 */
export interface DocumentsRepository extends DocumentIndexingRepository, RecoveryRepository {
  /**
   * Documents of the collection ordered by path (documents without a path last, by upload time),
   * filtered and paged; `total` counts all documents matching the filter.
   */
  listByCollection(
    collectionId: string,
    filter?: DocumentListFilter,
  ): Promise<{ items: DocumentMetadata[]; total: number }>;
  findById(id: string): Promise<DocumentMetadata | undefined>;
  findContent(id: string): Promise<{ id: string; content: string } | undefined>;
  /** Documents of the collection whose content hash is one of `hashes`. */
  findByContentHashes(collectionId: string, hashes: string[]): Promise<ExistingDocumentRef[]>;
  /** Documents of the collection whose path is one of `paths`. */
  findByPaths(collectionId: string, paths: string[]): Promise<ExistingDocumentRef[]>;
  /** Inserts all records in one statement (all or nothing); row order is not guaranteed. */
  insertMany(records: NewDocumentRecord[]): Promise<DocumentMetadata[]>;
  /** Deletes the document; its chunks are removed by `ON DELETE CASCADE`. */
  delete(id: string): Promise<boolean>;
  /**
   * Atomically moves the document from `from` back to `pending` (reindex) and returns it, or
   * `undefined` if it does not exist or its status is no longer `from` (concurrent change).
   */
  requeue(id: string, from: DocumentStatus): Promise<DocumentMetadata | undefined>;
}

const metadataColumns = {
  id: documents.id,
  collectionId: documents.collectionId,
  filename: documents.filename,
  path: documents.path,
  mimeType: documents.mimeType,
  sizeBytes: documents.sizeBytes,
  contentSha256: documents.contentSha256,
  status: documents.status,
  errorMessage: documents.errorMessage,
  chunkCount: documents.chunkCount,
  metadata: documents.metadata,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
};

const indexingColumns = {
  id: documents.id,
  collectionId: documents.collectionId,
  filename: documents.filename,
  path: documents.path,
  mimeType: documents.mimeType,
  content: documents.content,
};

const existingRefColumns = {
  id: documents.id,
  contentSha256: documents.contentSha256,
  path: documents.path,
  status: documents.status,
};

export function createDocumentsRepository(db: Database): DocumentsRepository {
  return {
    async listByCollection(collectionId, filter = {}) {
      const conditions: SQL[] = [eq(documents.collectionId, collectionId)];
      if (filter.pathPrefix !== undefined && filter.pathPrefix !== '') {
        // starts_with() takes the prefix literally (no LIKE wildcards to escape).
        conditions.push(sql`starts_with(${documents.path}, ${filter.pathPrefix})`);
      }
      const where = and(...conditions);
      let query = db
        .select(metadataColumns)
        .from(documents)
        .where(where)
        .orderBy(sql`${documents.path} ASC NULLS LAST`, documents.createdAt, documents.id)
        .$dynamic();
      if (filter.limit !== undefined) {
        query = query.limit(filter.limit).offset(filter.offset ?? 0);
      }
      const [items, totals] = await Promise.all([
        query,
        db.select({ total: count() }).from(documents).where(where),
      ]);
      return { items, total: totals[0]?.total ?? 0 };
    },

    async findById(id) {
      const rows = await db.select(metadataColumns).from(documents).where(eq(documents.id, id));
      return rows[0];
    },

    async findContent(id) {
      const rows = await db
        .select({ id: documents.id, content: documents.content })
        .from(documents)
        .where(eq(documents.id, id));
      return rows[0];
    },

    async findByContentHashes(collectionId, hashes) {
      if (hashes.length === 0) {
        return [];
      }
      return db
        .select(existingRefColumns)
        .from(documents)
        .where(
          and(eq(documents.collectionId, collectionId), inArray(documents.contentSha256, hashes)),
        );
    },

    async findByPaths(collectionId, paths) {
      if (paths.length === 0) {
        return [];
      }
      return db
        .select(existingRefColumns)
        .from(documents)
        .where(and(eq(documents.collectionId, collectionId), inArray(documents.path, paths)));
    },

    async insertMany(records) {
      if (records.length === 0) {
        return [];
      }
      // A single multi-row INSERT is atomic: either every document is stored or none.
      return db.insert(documents).values(records).returning(metadataColumns);
    },

    async delete(id) {
      const deleted = await db
        .delete(documents)
        .where(eq(documents.id, id))
        .returning({ id: documents.id });
      return deleted.length > 0;
    },

    async requeue(id, from) {
      const rows = await db
        .update(documents)
        .set({ status: 'pending', errorMessage: null })
        .where(and(eq(documents.id, id), eq(documents.status, from)))
        .returning(metadataColumns);
      return rows[0];
    },

    async claimForProcessing(id): Promise<IndexingDocument | undefined> {
      const rows = await db
        .update(documents)
        .set({ status: 'processing', errorMessage: null })
        .where(and(eq(documents.id, id), inArray(documents.status, ['pending', 'failed'])))
        .returning(indexingColumns);
      return rows[0];
    },

    async markReady(id, chunkCount) {
      await db
        .update(documents)
        .set({ status: 'ready', chunkCount, errorMessage: null })
        .where(and(eq(documents.id, id), eq(documents.status, 'processing')));
    },

    async markFailed(id, errorMessage) {
      await db
        .update(documents)
        .set({ status: 'failed', errorMessage })
        .where(and(eq(documents.id, id), eq(documents.status, 'processing')));
    },

    async failInterrupted(errorMessage) {
      const rows = await db
        .update(documents)
        .set({ status: 'failed', errorMessage })
        .where(eq(documents.status, 'processing'))
        .returning({ id: documents.id });
      return rows.length;
    },

    async listPendingIds() {
      const rows = await db
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.status, 'pending'))
        .orderBy(asc(documents.createdAt), asc(documents.id));
      return rows.map((row) => row.id);
    },
  };
}
