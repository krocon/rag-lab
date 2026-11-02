import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPgProbe } from '../../src/db/probe.js';
import { createServices } from '../../src/services.js';
import { createFakeEmbeddingProvider } from '../fakes/fake-embedding-provider.js';
import { silentLogger, testConfig } from '../helpers.js';
import { integrationDatabaseUrl } from './setup.js';

const databaseUrl = integrationDatabaseUrl();

describe('database integration', () => {
  const connection = createDatabase(databaseUrl, 2);
  const { pool } = connection;

  beforeAll(async () => {
    await runMigrations(databaseUrl);
  });

  afterAll(async () => {
    await connection.close();
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

  async function readiness(embeddingDimensions: string) {
    const config = testConfig({
      DATABASE_URL: databaseUrl,
      EMBEDDING_DIMENSIONS: embeddingDimensions,
    });
    const app = await buildApp({
      config,
      probe: createPgProbe(pool, { embeddingDimensions: config.embedding.dimensions }),
      services: createServices(connection.db, config, silentLogger, {
        embeddingProvider: createFakeEmbeddingProvider(),
      }),
      logger: false,
    });
    try {
      return await app.inject({ method: 'GET', url: '/api/health/ready' });
    } finally {
      await app.close();
    }
  }

  it('reports readiness when EMBEDDING_DIMENSIONS matches the embedding column', async () => {
    const response = await readiness('768');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ready',
      checks: {
        database: { status: 'up' },
        pgvector: { status: 'up' },
        schema: { status: 'up', expected: 768, actual: 768 },
      },
    });
  });

  it('reports not_ready when EMBEDDING_DIMENSIONS differs from the embedding column', async () => {
    const response = await readiness('1024');

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'not_ready',
      checks: {
        database: { status: 'up' },
        pgvector: { status: 'up' },
        schema: { status: 'down', expected: 1024, actual: 768 },
      },
    });
  });
});
