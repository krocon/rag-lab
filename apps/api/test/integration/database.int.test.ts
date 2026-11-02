import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadEnvFile } from '../../src/config/load-env-file.js';
import { createPgProbe } from '../../src/db/probe.js';
import { runMigrations } from '../../src/db/migrate.js';
import { testConfig } from '../helpers.js';

/**
 * Requires a reachable PostgreSQL with the pgvector image, e.g. `pnpm db:up`.
 * Uses DATABASE_URL from the environment (CI) or from the repository-root `.env`.
 */
loadEnvFile();
const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set – copy .env.example to .env or export it.');
}

describe('database integration', () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });

  beforeAll(async () => {
    await runMigrations(databaseUrl);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('migrations are idempotent', async () => {
    await expect(runMigrations(databaseUrl)).resolves.toBeUndefined();
  });

  it('installs the pgvector extension', async () => {
    const result = await pool.query<{ extversion: string }>(
      "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
    );
    expect(result.rows[0]?.extversion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('computes cosine distance with the <=> operator', async () => {
    const result = await pool.query<{ distance: number }>(
      "SELECT ('[1,0,0]'::vector <=> '[0,1,0]'::vector) AS distance",
    );
    expect(result.rows[0]?.distance).toBeCloseTo(1);
  });

  it('reports readiness against the real database', async () => {
    const app = await buildApp({
      config: testConfig({ DATABASE_URL: databaseUrl }),
      probe: createPgProbe(pool),
      logger: false,
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/health/ready' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: 'ready',
        checks: { database: { status: 'up' }, pgvector: { status: 'up' } },
      });
    } finally {
      await app.close();
    }
  });
});
