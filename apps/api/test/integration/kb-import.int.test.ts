import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPgProbe } from '../../src/db/probe.js';
import { createServices } from '../../src/services.js';
import { createFakeEmbeddingProvider } from '../fakes/fake-embedding-provider.js';
import { silentLogger, testConfig } from '../helpers.js';
import { integrationDatabaseUrl, resetDatabase } from './setup.js';

/**
 * `pnpm kb:import` (scripts/kb/import-lib.mjs) against the real API with PostgreSQL and a fake
 * embedding provider, over HTTP on a random port: first import, second run without uploads and
 * `--sync` (prompt 017). No network beyond localhost, no model.
 */
interface ImportLib {
  runImport(options: Record<string, unknown>): Promise<{
    uploaded?: string[];
    replaced?: string[];
    deleted?: string[];
    rejected?: { path: string; code: string }[];
    created?: boolean;
    collection?: { id: string };
    plan?: { unchanged: unknown[] };
    documents?: { path: string | null; status: string; chunkCount: number }[];
  }>;
}

// The CLI is plain JavaScript outside this package; imported at run time without type checking.
const importLibUrl = new URL('../../../../scripts/kb/import-lib.mjs', import.meta.url).href;

const databaseUrl = integrationDatabaseUrl();
const connection = createDatabase(databaseUrl, 4);
let app: FastifyInstance;
let apiUrl: string;
let root: string;
let lib: ImportLib;

async function put(path: string, content: string) {
  const absolute = join(root, ...path.split('/'));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

beforeAll(async () => {
  await runMigrations(databaseUrl);
  await resetDatabase(connection.pool);
  const config = testConfig({
    DATABASE_URL: databaseUrl,
    MAX_UPLOAD_FILES: '2',
    RATE_LIMIT_ENABLED: 'false',
  });
  app = await buildApp({
    config,
    probe: createPgProbe(connection.pool, { embeddingDimensions: config.embedding.dimensions }),
    services: createServices(connection.db, config, silentLogger, {
      embeddingProvider: createFakeEmbeddingProvider(),
    }),
    logger: false,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apiUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  lib = (await import(importLibUrl)) as ImportLib;
  root = await mkdtemp(join(tmpdir(), 'raglab-kb-import-'));
  await put('README.md', '# Tree table\n\nRows with children.\n');
  await put('src/tree.ts', 'export class TreeTableModel {\n  rows = [];\n}\n');
  await put('src/pivot.ts', 'export function createPivotModel() {\n  return {};\n}\n');
  await put('.env', 'TOKEN=never-uploaded');
  await put('node_modules/x/index.js', 'module.exports = 1;');
});

afterAll(async () => {
  await app.close();
  await resetDatabase(connection.pool);
  await connection.close();
  await rm(root, { recursive: true, force: true });
});

const run = (extra: Record<string, unknown> = {}) =>
  lib.runImport({
    source: root,
    name: 'Imported code',
    apiUrl,
    pollIntervalMs: 50,
    timeoutMs: 15_000,
    ...extra,
  });

describe('kb:import against the API (PostgreSQL, fake embeddings)', () => {
  it('imports, skips unchanged files on a second run and syncs changes', async () => {
    const first = await run();
    expect(first.created).toBe(true);
    expect(first.uploaded).toEqual(['README.md', 'src/pivot.ts', 'src/tree.ts']);
    expect(first.rejected).toEqual([]);
    expect(first.documents?.map((d) => [d.path, d.status])).toEqual([
      ['README.md', 'ready'],
      ['src/pivot.ts', 'ready'],
      ['src/tree.ts', 'ready'],
    ]);

    const collection = await app.inject({
      method: 'GET',
      url: `/api/collections/${first.collection?.id}`,
    });
    expect(collection.json<{ source: unknown }>().source).toMatchObject({ kind: 'directory' });
    expect(collection.body).not.toContain('never-uploaded');

    const second = await run();
    expect(second.created).toBe(false);
    expect(second.uploaded).toEqual([]);
    expect(second.plan?.unchanged).toHaveLength(3);

    await put('src/tree.ts', 'export class TreeTableModel {\n  rows: unknown[] = [];\n}\n');
    await unlink(join(root, 'src', 'pivot.ts'));
    const notSynced = await run();
    expect(notSynced.uploaded).toEqual([]);
    expect(notSynced.deleted).toEqual([]);

    const synced = await run({ sync: true });
    expect(synced.replaced).toEqual(['src/tree.ts']);
    expect(synced.deleted).toEqual(['src/pivot.ts']);
    expect(synced.uploaded).toEqual(['src/tree.ts']);
    expect(synced.documents?.map((d) => [d.path, d.status])).toEqual([
      ['README.md', 'ready'],
      ['src/tree.ts', 'ready'],
    ]);
  });
});
