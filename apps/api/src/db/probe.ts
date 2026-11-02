import type pg from 'pg';
import type { ReadinessResponse } from '@raglab/shared';

type Checks = ReadinessResponse['checks'];

/** Reports whether the database, the pgvector extension and the schema are usable. */
export interface DatabaseProbe {
  check(): Promise<Checks>;
}

export interface PgProbeOptions {
  /** `EMBEDDING_DIMENSIONS` from the configuration; must equal the `chunks.embedding` column. */
  embeddingDimensions: number;
}

/**
 * For pgvector's `vector(n)` type, `atttypmod` holds `n` directly (`-1` = no dimension declared).
 * No row means the table or column does not exist (migrations not applied).
 */
export const EMBEDDING_COLUMN_QUERY = `
  SELECT a.atttypmod AS dimensions
  FROM pg_attribute a
  WHERE a.attrelid = to_regclass('public.chunks')
    AND a.attname = 'embedding'
    AND NOT a.attisdropped`;

export function createPgProbe(
  pool: pg.Pool,
  { embeddingDimensions }: PgProbeOptions,
): DatabaseProbe {
  async function checkSchema(): Promise<Checks['schema']> {
    const expected = embeddingDimensions;
    try {
      const result = await pool.query<{ dimensions: number }>(EMBEDDING_COLUMN_QUERY);
      const row = result.rows[0];
      if (!row) {
        return {
          status: 'down',
          expected,
          actual: null,
          error: 'column chunks.embedding not found – run pnpm db:migrate',
        };
      }
      const actual = row.dimensions > 0 ? row.dimensions : null;
      if (actual !== expected) {
        return {
          status: 'down',
          expected,
          actual,
          error:
            `EMBEDDING_DIMENSIONS is ${expected}, but the database column chunks.embedding has ` +
            `${actual ?? 'no fixed'} dimensions. Use a model with matching dimensions or add a ` +
            'migration that changes the column (and re-embed all chunks).',
        };
      }
      return { status: 'up', expected, actual };
    } catch (error) {
      return { status: 'down', expected, error: errorMessage(error) };
    }
  }

  return {
    async check() {
      const started = performance.now();
      try {
        await pool.query('SELECT 1');
      } catch (error) {
        const message = errorMessage(error);
        return {
          database: { status: 'down', error: message },
          pgvector: { status: 'down', error: 'database unreachable' },
          schema: { status: 'down', expected: embeddingDimensions, error: 'database unreachable' },
        };
      }
      const database: Checks['database'] = {
        status: 'up',
        latencyMs: Math.round(performance.now() - started),
      };
      let pgvector: Checks['pgvector'];
      try {
        const result = await pool.query<{ extversion: string }>(
          "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
        );
        const version = result.rows[0]?.extversion;
        pgvector = version
          ? { status: 'up', version }
          : { status: 'down', error: 'extension "vector" not installed – run pnpm db:migrate' };
      } catch (error) {
        pgvector = { status: 'down', error: errorMessage(error) };
      }
      return { database, pgvector, schema: await checkSchema() };
    },
  };
}

/** True when every component of a readiness check is up. */
export function isReady(checks: Checks): boolean {
  return Object.values(checks).every((check) => check.status === 'up');
}

function errorMessage(error: unknown): string {
  // Never surface connection strings; pg error messages do not contain credentials.
  return error instanceof Error ? error.message : 'unknown error';
}
