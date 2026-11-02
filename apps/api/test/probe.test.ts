import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { createPgProbe, isReady } from '../src/db/probe.js';
import { EMBEDDING_COLUMN_DIMENSIONS } from '../src/db/schema.js';

/** Fake pool answering the probe's queries; `dimensions: undefined` = column missing. */
function fakePool({ dimensions, down = false }: { dimensions?: number; down?: boolean }): pg.Pool {
  return {
    query: async (text: string) => {
      if (down) {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      }
      if (text.includes('pg_extension')) {
        return { rows: [{ extversion: '0.8.7' }] };
      }
      if (text.includes('pg_attribute')) {
        return { rows: dimensions === undefined ? [] : [{ dimensions }] };
      }
      return { rows: [{ '?column?': 1 }] };
    },
  } as unknown as pg.Pool;
}

describe('createPgProbe – schema check', () => {
  it('is up when the column dimension matches EMBEDDING_DIMENSIONS', async () => {
    const checks = await createPgProbe(fakePool({ dimensions: 768 }), {
      embeddingDimensions: 768,
    }).check();

    expect(checks.schema).toEqual({ status: 'up', expected: 768, actual: 768 });
    expect(isReady(checks)).toBe(true);
  });

  it('is down with an explanation when the dimensions differ', async () => {
    const checks = await createPgProbe(fakePool({ dimensions: 768 }), {
      embeddingDimensions: 1024,
    }).check();

    expect(checks.schema).toMatchObject({ status: 'down', expected: 1024, actual: 768 });
    expect(checks.schema.error).toContain('EMBEDDING_DIMENSIONS is 1024');
    expect(isReady(checks)).toBe(false);
  });

  it('is down when the chunks table has not been migrated', async () => {
    const checks = await createPgProbe(fakePool({}), { embeddingDimensions: 768 }).check();

    expect(checks.schema).toMatchObject({ status: 'down', actual: null });
    expect(checks.schema.error).toContain('pnpm db:migrate');
  });

  it('reports every component down when the database is unreachable', async () => {
    const checks = await createPgProbe(fakePool({ down: true }), {
      embeddingDimensions: 768,
    }).check();

    expect(checks.database.status).toBe('down');
    expect(checks.schema).toMatchObject({ status: 'down', expected: 768 });
    expect(isReady(checks)).toBe(false);
  });
});

describe('embedding column dimension', () => {
  it('matches EMBEDDING_DIMENSIONS in .env.example', () => {
    const example = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    const env = Object.fromEntries(
      example
        .split('\n')
        .filter((line) => /^[A-Z_]+=/.test(line))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );

    expect(loadConfig(env).embedding.dimensions).toBe(EMBEDDING_COLUMN_DIMENSIONS);
  });
});
