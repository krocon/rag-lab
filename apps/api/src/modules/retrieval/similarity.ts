/**
 * The single definition of RAGLab's vector similarity metric (docs/adr/0002-rag-pipeline.md §4).
 *
 * - Metric: **cosine distance**, pgvector operator `<=>`, range 0..2 (0 = same direction,
 *   1 = orthogonal, 2 = opposite). Lower is more similar.
 * - Index: `USING hnsw (embedding vector_cosine_ops)` – the operator class must match the
 *   operator, otherwise PostgreSQL cannot use the index for `ORDER BY embedding <=> $q`.
 * - Score: `score = 1 - distance` = cosine similarity, range -1..1. Higher is more similar.
 *
 * The API always returns both values under these names; they are never mixed up or renamed.
 * This file has no imports on purpose: `src/db/schema.ts` (loaded by drizzle-kit) uses it too.
 */

/** pgvector operator for cosine distance. */
export const DISTANCE_OPERATOR = '<=>';

/** HNSW operator class matching {@link DISTANCE_OPERATOR}. */
export const VECTOR_OPCLASS = 'vector_cosine_ops';

/** Smallest and largest possible cosine distance. */
export const MIN_DISTANCE = 0;
export const MAX_DISTANCE = 2;

/** Converts a cosine distance (`<=>`) into a score (cosine similarity): `1 - distance`. */
export function toScore(distance: number): number {
  return 1 - distance;
}

/** Inverse of {@link toScore}: the largest distance that still reaches `score`. */
export function toDistance(score: number): number {
  return 1 - score;
}
