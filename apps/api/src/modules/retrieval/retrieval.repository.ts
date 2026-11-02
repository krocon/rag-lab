import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { chunks, documents } from '../../db/schema.js';
import { toVectorLiteral } from '../../db/vector.js';
import { DISTANCE_OPERATOR } from './similarity.js';

/**
 * A chunk found by the vector search, before ranking and scoring. (A type alias, not an
 * interface, so it satisfies drizzle's `Record<string, unknown>` row constraint.)
 */
export type RetrievedChunk = {
  chunkId: string;
  documentId: string;
  filename: string;
  chunkIndex: number;
  content: string;
  headingPath: string[];
  startOffset: number;
  endOffset: number;
  /** Raw cosine distance (`<=>`). */
  distance: number;
};

export interface VectorSearchParams {
  collectionId: string;
  /** Query vector; its length must equal the column dimension. */
  embedding: readonly number[];
  /** `LIMIT` of the search (1..100). */
  limit: number;
}

/**
 * Read-only vector search over `chunks` joined with `documents`.
 *
 * Deliberate exception to "modules use other modules' services, never their tables": the
 * collection and status filters must be part of the **same** SQL statement as
 * `ORDER BY … LIMIT` (ADR 0002 §4), which a service call cannot provide. The repository never
 * writes.
 */
export interface RetrievalRepository {
  /**
   * Up to `limit` chunks of the collection, nearest first by the database (with
   * `relaxed_order` the order may be slightly off – callers sort again).
   * Only chunks with `embedding IS NOT NULL` of documents with status `ready`.
   */
  search(params: VectorSearchParams): Promise<RetrievedChunk[]>;
}

/** pgvector's default `hnsw.ef_search`. */
export const DEFAULT_EF_SEARCH = 40;

/** `hnsw.iterative_scan` of every search transaction (see {@link searchSettingsQuery}). */
export const ITERATIVE_SCAN_MODE = 'relaxed_order';

/** `hnsw.ef_search` for a search with `LIMIT limit`: at least as long as `LIMIT`. */
export function efSearchFor(limit: number): number {
  return Math.max(DEFAULT_EF_SEARCH, limit);
}

/**
 * Transaction-local search settings (`set_config(…, true)` ≙ `SET LOCAL`, but with bind
 * parameters):
 *
 * - `hnsw.iterative_scan = relaxed_order` (pgvector ≥ 0.8): HNSW returns candidates by distance
 *   and the `WHERE` filter is applied afterwards. Without iterative scans, a collection whose
 *   chunks are not among the `ef_search` nearest neighbours of *all* chunks gets too few or no
 *   results. With it, the index keeps scanning (up to `hnsw.max_scan_tuples`, default 20,000)
 *   until `LIMIT` rows pass the filter. `relaxed_order` may return rows slightly out of order,
 *   so the service sorts again; `strict_order` would be exact but slower.
 * - `hnsw.ef_search = max(40, limit)`: the candidate list must be at least as long as `LIMIT`.
 *
 * Both settings end with the transaction and never leak into other pooled connections.
 */
export function searchSettingsQuery(limit: number): SQL {
  const efSearch = String(efSearchFor(limit));
  return sql`SELECT set_config('hnsw.iterative_scan', ${ITERATIVE_SCAN_MODE}, true),
                    set_config('hnsw.ef_search', ${efSearch}, true)`;
}

/**
 * The search statement. The filters stand in the same statement before `ORDER BY … LIMIT`,
 * and `ORDER BY` uses the operator expression itself so the HNSW index
 * (`vector_cosine_ops`) can serve it. All user values are bind parameters.
 */
export function searchQuery({ collectionId, embedding, limit }: VectorSearchParams): SQL {
  const distance = sql`${chunks.embedding} ${sql.raw(DISTANCE_OPERATOR)} ${toVectorLiteral(embedding)}::vector`;
  return sql`
    SELECT ${chunks.id} AS "chunkId",
           ${chunks.documentId} AS "documentId",
           ${documents.filename} AS "filename",
           ${chunks.chunkIndex} AS "chunkIndex",
           ${chunks.content} AS "content",
           ${chunks.headingPath} AS "headingPath",
           ${chunks.startOffset} AS "startOffset",
           ${chunks.endOffset} AS "endOffset",
           ${distance} AS "distance"
      FROM ${chunks}
      JOIN ${documents} ON ${documents.id} = ${chunks.documentId}
     WHERE ${chunks.collectionId} = ${collectionId}
       AND ${chunks.embedding} IS NOT NULL
       AND ${documents.status} = 'ready'
     ORDER BY ${distance}
     LIMIT ${limit}`;
}

export function createRetrievalRepository(db: Database): RetrievalRepository {
  return {
    search: (params) =>
      db.transaction(async (tx) => {
        await tx.execute(searchSettingsQuery(params.limit));
        const result = await tx.execute<RetrievedChunk>(searchQuery(params));
        // node-postgres returns float8 as number and text[] as string[].
        return result.rows.map((row) => ({ ...row, distance: Number(row.distance) }));
      }),
  };
}
