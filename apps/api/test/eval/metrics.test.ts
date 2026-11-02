import { describe, expect, it } from 'vitest';
import {
  averageLevelMetrics,
  computeLevelMetrics,
  hitAtK,
  mean,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  type RankedItem,
} from '../../src/eval/metrics.js';

/** Document-level ranking: one document name per rank. */
const docs = (...names: string[]): RankedItem[] => names.map((name) => [name]);
const relevant = (...ids: string[]) => new Set(ids);

describe('retrieval metrics (hand-computed examples)', () => {
  // Ranking: x, a, y, b, z – relevant: a, b, c.
  const ranked = docs('x', 'a', 'y', 'b', 'z');
  const gold = relevant('a', 'b', 'c');

  it('Recall@K counts the share of relevant items found in the top K', () => {
    expect(recallAtK(ranked, gold, 1)).toBe(0);
    expect(recallAtK(ranked, gold, 2)).toBeCloseTo(1 / 3);
    expect(recallAtK(ranked, gold, 5)).toBeCloseTo(2 / 3);
  });

  it('Precision@K divides relevant results by K (also beyond the end of the list)', () => {
    expect(precisionAtK(ranked, gold, 1)).toBe(0);
    expect(precisionAtK(ranked, gold, 4)).toBe(0.5);
    expect(precisionAtK(ranked, gold, 10)).toBe(0.2);
  });

  it('Hit-Rate@K is 1 as soon as one relevant result is in the top K', () => {
    expect(hitAtK(ranked, gold, 1)).toBe(0);
    expect(hitAtK(ranked, gold, 2)).toBe(1);
  });

  it('reciprocal rank uses the first relevant result', () => {
    expect(reciprocalRank(ranked, gold)).toBe(0.5);
  });

  it('scores a hit at rank 1 with 1 everywhere', () => {
    const top = docs('a', 'x', 'y');
    expect(recallAtK(top, relevant('a'), 1)).toBe(1);
    expect(precisionAtK(top, relevant('a'), 1)).toBe(1);
    expect(hitAtK(top, relevant('a'), 1)).toBe(1);
    expect(reciprocalRank(top, relevant('a'))).toBe(1);
  });

  it('scores 0 when nothing relevant is retrieved (also for an empty result list)', () => {
    for (const list of [docs('x', 'y'), []]) {
      expect(recallAtK(list, relevant('a'), 3)).toBe(0);
      expect(precisionAtK(list, relevant('a'), 3)).toBe(0);
      expect(hitAtK(list, relevant('a'), 3)).toBe(0);
      expect(reciprocalRank(list, relevant('a'))).toBe(0);
    }
  });

  it('is undefined (null) without relevant items instead of 0 or 1', () => {
    const none = relevant();
    expect(recallAtK(ranked, none, 3)).toBeNull();
    expect(precisionAtK(ranked, none, 3)).toBeNull();
    expect(hitAtK(ranked, none, 3)).toBeNull();
    expect(reciprocalRank(ranked, none)).toBeNull();
  });

  it('counts duplicates once for recall but every relevant chunk for precision', () => {
    // Three chunks of document a, then b.
    const duplicates = docs('a', 'a', 'a', 'b');
    expect(recallAtK(duplicates, relevant('a', 'b'), 3)).toBe(0.5);
    expect(precisionAtK(duplicates, relevant('a', 'b'), 3)).toBe(1);
    expect(recallAtK(duplicates, relevant('a', 'b'), 4)).toBe(1);
  });

  it('handles ranks that cover several or no anchors (section level)', () => {
    const sections: RankedItem[] = [[], ['s1', 's2'], ['s3']];
    expect(recallAtK(sections, relevant('s1', 's2', 's3', 's4'), 2)).toBe(0.5);
    expect(precisionAtK(sections, relevant('s1', 's2', 's3', 's4'), 2)).toBe(0.5);
    expect(reciprocalRank(sections, relevant('s3'))).toBeCloseTo(1 / 3);
  });

  it('rejects invalid K', () => {
    expect(() => recallAtK(ranked, gold, 0)).toThrow(RangeError);
    expect(() => precisionAtK(ranked, gold, 1.5)).toThrow(RangeError);
  });
});

describe('aggregation', () => {
  it('mean ignores undefined values', () => {
    expect(mean([1, null, 0])).toBe(0.5);
    expect(mean([null])).toBeNull();
    expect(mean([])).toBeNull();
  });

  it('computes all K and averages per query (macro average)', () => {
    const first = computeLevelMetrics(docs('a', 'x'), relevant('a'), [1, 2]);
    const second = computeLevelMetrics(docs('x', 'b'), relevant('b'), [1, 2]);
    expect(first).toEqual({
      atK: {
        '1': { recall: 1, precision: 1, hitRate: 1 },
        '2': { recall: 1, precision: 0.5, hitRate: 1 },
      },
      mrr: 1,
    });
    expect(averageLevelMetrics([first, second], [1, 2])).toEqual({
      atK: {
        '1': { recall: 0.5, precision: 0.5, hitRate: 0.5 },
        '2': { recall: 1, precision: 0.5, hitRate: 1 },
      },
      mrr: 0.75,
    });
  });
});
