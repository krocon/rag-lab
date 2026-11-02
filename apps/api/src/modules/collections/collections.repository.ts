import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  chunks,
  collections,
  documents,
  type Collection,
  type DocumentStatus,
} from '../../db/schema.js';

/** Name of the case-insensitive unique index on `lower(name)` (see schema.ts). */
export const COLLECTION_NAME_UNIQUE_INDEX = 'collections_name_lower_unique';

export interface CollectionStats {
  documentCount: number;
  readyDocumentCount: number;
  chunkCount: number;
}

export type CollectionWithStats = Collection & CollectionStats;

/** Index state of a collection (retrieval diagnostics, playground). */
export interface CollectionIndexStats {
  documentCount: number;
  documentsByStatus: Record<DocumentStatus, number>;
  /** All stored chunks. */
  chunkCount: number;
  /** Chunks with an embedding of `ready` documents – the ones the vector search can find. */
  searchableChunkCount: number;
  /** Chunks without an embedding (any document status). */
  chunksWithoutEmbedding: number;
}

export interface NewCollectionRecord {
  name: string;
  description: string | null;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimensions: number;
}

export interface CollectionPatch {
  name?: string;
  description?: string | null;
}

/** Persistence of collections. Unique violations surface as PostgreSQL errors (23505). */
export interface CollectionsRepository {
  list(): Promise<CollectionWithStats[]>;
  findById(id: string): Promise<CollectionWithStats | undefined>;
  exists(id: string): Promise<boolean>;
  insert(record: NewCollectionRecord): Promise<CollectionWithStats>;
  update(id: string, patch: CollectionPatch): Promise<CollectionWithStats | undefined>;
  /** Deletes the collection; documents and chunks are removed by `ON DELETE CASCADE`. */
  delete(id: string): Promise<boolean>;
  /** Document and chunk counts; all zero for an unknown collection. */
  indexStats(id: string): Promise<CollectionIndexStats>;
}

const EMPTY_STATS: CollectionStats = { documentCount: 0, readyDocumentCount: 0, chunkCount: 0 };

export function createCollectionsRepository(db: Database): CollectionsRepository {
  // Correlated sub-queries use the indexes on documents(collection_id, status) and chunks(collection_id).
  // Drizzle omits table names in single-table selects, so the outer column is qualified explicitly.
  const outerId = sql`${sql.identifier('collections')}.${sql.identifier('id')}`;
  const statsColumns = {
    documentCount: sql<number>`(SELECT count(*)::int FROM ${documents} d WHERE d.collection_id = ${outerId})`,
    readyDocumentCount: sql<number>`(SELECT count(*)::int FROM ${documents} d WHERE d.collection_id = ${outerId} AND d.status = 'ready')`,
    chunkCount: sql<number>`(SELECT count(*)::int FROM ${chunks} c WHERE c.collection_id = ${outerId})`,
  };

  const selectWithStats = () =>
    db
      .select({
        id: collections.id,
        name: collections.name,
        description: collections.description,
        embeddingProvider: collections.embeddingProvider,
        embeddingModel: collections.embeddingModel,
        embeddingDimensions: collections.embeddingDimensions,
        createdAt: collections.createdAt,
        updatedAt: collections.updatedAt,
        ...statsColumns,
      })
      .from(collections);

  async function findById(id: string): Promise<CollectionWithStats | undefined> {
    const rows = await selectWithStats().where(eq(collections.id, id));
    return rows[0];
  }

  return {
    list: () => selectWithStats().orderBy(collections.createdAt, collections.id),

    findById,

    async exists(id) {
      const rows = await db
        .select({ id: collections.id })
        .from(collections)
        .where(eq(collections.id, id));
      return rows.length > 0;
    },

    async insert(record) {
      const [row] = await db.insert(collections).values(record).returning();
      if (!row) {
        throw new Error('INSERT … RETURNING returned no row');
      }
      return { ...row, ...EMPTY_STATS };
    },

    async update(id, patch) {
      const updated = await db
        .update(collections)
        .set(patch)
        .where(eq(collections.id, id))
        .returning({ id: collections.id });
      return updated.length > 0 ? findById(id) : undefined;
    },

    async delete(id) {
      const deleted = await db
        .delete(collections)
        .where(eq(collections.id, id))
        .returning({ id: collections.id });
      return deleted.length > 0;
    },

    async indexStats(id) {
      // Two aggregates (documents by status, chunks by embedding state) in one round trip; the
      // searchable count uses the same filters as the retrieval SQL (embedding, status `ready`).
      const result = await db.execute<{
        pending: number;
        processing: number;
        ready: number;
        failed: number;
        chunkCount: number;
        searchableChunkCount: number;
        chunksWithoutEmbedding: number;
      }>(sql`
        SELECT d.pending, d.processing, d.ready, d.failed,
               c."chunkCount", c."searchableChunkCount", c."chunksWithoutEmbedding"
          FROM (SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
                       count(*) FILTER (WHERE status = 'processing')::int AS processing,
                       count(*) FILTER (WHERE status = 'ready')::int AS ready,
                       count(*) FILTER (WHERE status = 'failed')::int AS failed
                  FROM ${documents}
                 WHERE ${documents.collectionId} = ${id}) AS d,
               (SELECT count(*)::int AS "chunkCount",
                       count(*) FILTER (WHERE ${chunks.embedding} IS NOT NULL
                                          AND ${documents.status} = 'ready')::int AS "searchableChunkCount",
                       count(*) FILTER (WHERE ${chunks.embedding} IS NULL)::int AS "chunksWithoutEmbedding"
                  FROM ${chunks}
                  JOIN ${documents} ON ${documents.id} = ${chunks.documentId}
                 WHERE ${chunks.collectionId} = ${id}) AS c`);
      const row = result.rows[0];
      const documentsByStatus = {
        pending: row?.pending ?? 0,
        processing: row?.processing ?? 0,
        ready: row?.ready ?? 0,
        failed: row?.failed ?? 0,
      };
      return {
        documentCount: Object.values(documentsByStatus).reduce((sum, value) => sum + value, 0),
        documentsByStatus,
        chunkCount: row?.chunkCount ?? 0,
        searchableChunkCount: row?.searchableChunkCount ?? 0,
        chunksWithoutEmbedding: row?.chunksWithoutEmbedding ?? 0,
      };
    },
  };
}
