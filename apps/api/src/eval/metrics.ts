/**
 * Retrieval metrics (docs/evaluation.md §2) as pure functions.
 *
 * Input model: a ranked result list where every rank carries the ids of the relevant items it
 * covers (empty = not relevant), plus the set of relevant item ids of the query.
 * - Document level: a result (chunk) covers `[filename]` if its document is relevant.
 * - Section level: a result covers the ids of the relevance anchors it matches (heading section or
 *   text marker; an anchor without heading/marker covers the whole document).
 *
 * `K` is the number of retrieved chunks looked at (the chat's `topK`), not the number of distinct
 * documents. Duplicates – several chunks covering the same relevant item – count once for recall
 * (an item is found or not) but every relevant chunk counts for precision (each one is a useful
 * context block). Fewer than K results are treated as non-relevant ranks (denominator stays K).
 *
 * Every function returns `null` when the query has no relevant items: the metric is undefined then
 * and the query is left out of averages instead of counting as 0 or 1.
 */
export type RankedItem = readonly string[];

function assertK(k: number): void {
  if (!Number.isInteger(k) || k < 1) {
    throw new RangeError(`K must be a positive integer, got ${k}`);
  }
}

const isRelevant = (item: RankedItem, relevant: ReadonlySet<string>) =>
  item.some((id) => relevant.has(id));

/**
 * Recall@K = |relevant items covered by the first K results| / |relevant items|.
 * Range 0..1; 1 means every relevant item appears at least once in the top K.
 */
export function recallAtK(
  ranked: readonly RankedItem[],
  relevant: ReadonlySet<string>,
  k: number,
): number | null {
  assertK(k);
  if (relevant.size === 0) {
    return null;
  }
  const found = new Set<string>();
  for (const item of ranked.slice(0, k)) {
    for (const id of item) {
      if (relevant.has(id)) {
        found.add(id);
      }
    }
  }
  return found.size / relevant.size;
}

/**
 * Precision@K = |relevant results among the first K| / K.
 * Range 0..1; with a single relevant section, the maximum at K = 3 is 1/3 unless several chunks
 * of it are retrieved – compare precision only between runs with the same K and chunking.
 */
export function precisionAtK(
  ranked: readonly RankedItem[],
  relevant: ReadonlySet<string>,
  k: number,
): number | null {
  assertK(k);
  if (relevant.size === 0) {
    return null;
  }
  const hits = ranked.slice(0, k).filter((item) => isRelevant(item, relevant)).length;
  return hits / k;
}

/** Hit-Rate@K = 1 if at least one of the first K results is relevant, else 0. */
export function hitAtK(
  ranked: readonly RankedItem[],
  relevant: ReadonlySet<string>,
  k: number,
): number | null {
  assertK(k);
  if (relevant.size === 0) {
    return null;
  }
  return ranked.slice(0, k).some((item) => isRelevant(item, relevant)) ? 1 : 0;
}

/**
 * Reciprocal rank = 1 / (1-based rank of the first relevant result), 0 if none is relevant.
 * Averaged over queries this is the MRR; it only looks at the ranks retrieved (MRR@maxK).
 */
export function reciprocalRank(
  ranked: readonly RankedItem[],
  relevant: ReadonlySet<string>,
): number | null {
  if (relevant.size === 0) {
    return null;
  }
  const index = ranked.findIndex((item) => isRelevant(item, relevant));
  return index === -1 ? 0 : 1 / (index + 1);
}

/** Arithmetic mean of the defined values; `null` if there are none. */
export function mean(values: readonly (number | null)[]): number | null {
  const defined = values.filter((value): value is number => value !== null);
  if (defined.length === 0) {
    return null;
  }
  return defined.reduce((sum, value) => sum + value, 0) / defined.length;
}

export interface MetricsAtK {
  recall: number | null;
  precision: number | null;
  hitRate: number | null;
}

export interface LevelMetrics {
  /** Keyed by K (as string, JSON-friendly). */
  atK: Record<string, MetricsAtK>;
  /** Reciprocal rank (per query) or MRR (aggregated). */
  mrr: number | null;
}

/** All metrics of one query at one relevance level. */
export function computeLevelMetrics(
  ranked: readonly RankedItem[],
  relevant: ReadonlySet<string>,
  ks: readonly number[],
): LevelMetrics {
  const atK: Record<string, MetricsAtK> = {};
  for (const k of ks) {
    atK[String(k)] = {
      recall: recallAtK(ranked, relevant, k),
      precision: precisionAtK(ranked, relevant, k),
      hitRate: hitAtK(ranked, relevant, k),
    };
  }
  return { atK, mrr: reciprocalRank(ranked, relevant) };
}

/** Macro average over queries (every query weighs the same). */
export function averageLevelMetrics(
  perQuery: readonly LevelMetrics[],
  ks: readonly number[],
): LevelMetrics {
  const atK: Record<string, MetricsAtK> = {};
  for (const k of ks) {
    const key = String(k);
    atK[key] = {
      recall: mean(perQuery.map((metrics) => metrics.atK[key]?.recall ?? null)),
      precision: mean(perQuery.map((metrics) => metrics.atK[key]?.precision ?? null)),
      hitRate: mean(perQuery.map((metrics) => metrics.atK[key]?.hitRate ?? null)),
    };
  }
  return { atK, mrr: mean(perQuery.map((metrics) => metrics.mrr)) };
}
