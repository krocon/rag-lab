import type pg from 'pg';
import type { ReadinessResponse } from '@raglab/shared';

type Checks = ReadinessResponse['checks'];

/** Reports whether the database and the pgvector extension are usable. */
export interface DatabaseProbe {
  check(): Promise<Checks>;
}

export function createPgProbe(pool: pg.Pool): DatabaseProbe {
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
        };
      }
      const database: Checks['database'] = {
        status: 'up',
        latencyMs: Math.round(performance.now() - started),
      };
      try {
        const result = await pool.query<{ extversion: string }>(
          "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
        );
        const version = result.rows[0]?.extversion;
        return {
          database,
          pgvector: version
            ? { status: 'up', version }
            : { status: 'down', error: 'extension "vector" not installed – run pnpm db:migrate' },
        };
      } catch (error) {
        return { database, pgvector: { status: 'down', error: errorMessage(error) } };
      }
    },
  };
}

function errorMessage(error: unknown): string {
  // Never surface connection strings; pg error messages do not contain credentials.
  return error instanceof Error ? error.message : 'unknown error';
}
