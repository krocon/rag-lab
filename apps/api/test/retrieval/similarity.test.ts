import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DISTANCE_OPERATOR,
  MAX_DISTANCE,
  MIN_DISTANCE,
  toDistance,
  toScore,
  VECTOR_OPCLASS,
} from '../../src/modules/retrieval/similarity.js';

describe('similarity', () => {
  it('defines cosine distance with the matching HNSW operator class', () => {
    expect(DISTANCE_OPERATOR).toBe('<=>');
    expect(VECTOR_OPCLASS).toBe('vector_cosine_ops');
    expect([MIN_DISTANCE, MAX_DISTANCE]).toEqual([0, 2]);
  });

  it('computes score = 1 - distance', () => {
    expect(toScore(0)).toBe(1);
    expect(toScore(1)).toBe(0);
    expect(toScore(2)).toBe(-1);
    expect(toScore(0.25)).toBeCloseTo(0.75);
  });

  it('inverts toScore with toDistance', () => {
    for (const distance of [0, 0.3, 1, 1.7, 2]) {
      expect(toDistance(toScore(distance))).toBeCloseTo(distance);
    }
  });

  it('matches the operator class of the HNSW index in the migration', () => {
    const migration = readFileSync(
      new URL('../../drizzle/0001_domain_model.sql', import.meta.url),
      'utf8',
    );
    expect(migration).toContain(`USING hnsw ("embedding" ${VECTOR_OPCLASS})`);
  });
});
