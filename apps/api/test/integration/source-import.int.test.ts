import type {
  ApiErrorResponse,
  CollectionDto,
  DocumentListResponse,
  DocumentChunksResponse,
  RetrievalSearchResponse,
  UploadDocumentsResponse,
} from '@raglab/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPgProbe } from '../../src/db/probe.js';
import { createServices } from '../../src/services.js';
import { createFakeEmbeddingProvider } from '../fakes/fake-embedding-provider.js';
import { silentLogger, testConfig } from '../helpers.js';
import { multipart, type MultipartFieldPart, type MultipartFilePart } from '../multipart.js';
import { integrationDatabaseUrl, resetDatabase } from './setup.js';

/**
 * Source import against PostgreSQL (prompt 017): migration 0002 (path column, partial unique
 * index, collection source), literal path prefix filter and paging in SQL, the full pipeline for
 * a TypeScript file (code chunks with lines and symbols) and source links in the retrieval.
 */
const databaseUrl = integrationDatabaseUrl();
const connection = createDatabase(databaseUrl, 4);
const { pool } = connection;
let app: FastifyInstance;
let services: ReturnType<typeof createServices>;

beforeAll(async () => {
  await runMigrations(databaseUrl);
  const config = testConfig({ DATABASE_URL: databaseUrl, CHUNK_SIZE: '300', CHUNK_OVERLAP: '40' });
  services = createServices(connection.db, config, silentLogger, {
    embeddingProvider: createFakeEmbeddingProvider(),
  });
  app = await buildApp({
    config,
    probe: createPgProbe(pool, { embeddingDimensions: config.embedding.dimensions }),
    services,
    logger: false,
  });
});

beforeEach(async () => {
  await resetDatabase(pool);
});

afterEach(async () => {
  // Let the background indexer finish before the next test empties the tables.
  const ids = (await pool.query<{ id: string }>('SELECT id FROM collections')).rows;
  for (const { id } of ids) {
    await waitUntilIndexed(id);
  }
});

afterAll(async () => {
  await app.close();
  await resetDatabase(pool);
  await connection.close();
});

async function createCollection(name: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/collections', payload: { name } });
  return response.json<CollectionDto>().id;
}

function upload(collectionId: string, parts: (MultipartFilePart | MultipartFieldPart)[]) {
  const { payload, headers } = multipart(parts);
  return app.inject({
    method: 'POST',
    url: `/api/collections/${collectionId}/documents`,
    payload,
    headers,
  });
}

const file = (path: string, content: string): (MultipartFilePart | MultipartFieldPart)[] => [
  { field: 'path', value: path },
  { filename: path.split('/').pop() ?? 'x', content },
];

async function waitUntilIndexed(collectionId: string): Promise<DocumentListResponse> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const list = (
      await app.inject({ method: 'GET', url: `/api/collections/${collectionId}/documents` })
    ).json<DocumentListResponse>();
    if (list.items.every((document) => document.status === 'ready' || document.status === 'failed')) {
      return list;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('indexing did not finish');
}

describe('documents with paths (PostgreSQL)', () => {
  it('enforces one document per path and collection, also against concurrent uploads', async () => {
    const collectionId = await createCollection('Paths');
    const other = await createCollection('Other');
    const results = await Promise.all([
      upload(collectionId, file('src/a.ts', 'const a = 1;')),
      upload(collectionId, file('src/a.ts', 'const a = 2;')),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([202, 409]);
    const conflict = results.find((response) => response.statusCode === 409);
    expect(conflict?.json<ApiErrorResponse>().error.code).toBe('DUPLICATE_PATH');
    // The same path in another collection is fine.
    expect((await upload(other, file('src/a.ts', 'const a = 1;'))).statusCode).toBe(202);
    // Uploads without a path are not affected by the partial index.
    expect((await upload(collectionId, [{ filename: 'a.md', content: '# A' }])).statusCode).toBe(202);
    expect((await upload(collectionId, [{ filename: 'a.md', content: '# B' }])).statusCode).toBe(202);
  });

  it('filters by literal path prefix and pages in SQL', async () => {
    const collectionId = await createCollection('Filter');
    await upload(collectionId, [
      ...file('packages/table/src/b.ts', 'const b = 1;'),
      ...file('packages/table/src/a.ts', 'const a = 1;'),
      ...file('packages/table_x/x.ts', 'const x = 1;'),
      ...file('docs/100%.md', '# Percent'),
    ]);
    await upload(collectionId, [{ filename: 'loose.md', content: '# Loose' }]);
    const list = async (query: string) =>
      (
        await app.inject({
          method: 'GET',
          url: `/api/collections/${collectionId}/documents${query}`,
        })
      ).json<DocumentListResponse>();

    expect((await list('')).items.map((document) => document.path)).toEqual([
      'docs/100%.md',
      'packages/table/src/a.ts',
      'packages/table/src/b.ts',
      'packages/table_x/x.ts',
      null,
    ]);
    // `_` and `%` are literal characters, not LIKE wildcards.
    expect((await list('?pathPrefix=packages/table_')).items.map((d) => d.path)).toEqual([
      'packages/table_x/x.ts',
    ]);
    expect((await list('?pathPrefix=docs/100%25')).total).toBe(1);
    const page = await list('?pathPrefix=packages/&limit=2&offset=1');
    expect(page.total).toBe(3);
    expect(page.items.map((d) => d.path)).toEqual(['packages/table/src/b.ts', 'packages/table_x/x.ts']);
  });

  it('rejects paths longer than the check constraint allows before reaching the database', async () => {
    const collectionId = await createCollection('Long');
    const response = await upload(collectionId, file(`${'a/'.repeat(300)}x.ts`, 'x'));
    expect(response.statusCode).toBe(400);
    expect(response.json<ApiErrorResponse>().error.code).toBe('INVALID_PATH');
  });
});

describe('source code through the whole pipeline (PostgreSQL)', () => {
  const TREE = [
    "import { EventEmitter } from 'node:events';",
    '',
    '/** A tree table model: rows with children. */',
    'export class TreeTableModel extends EventEmitter {',
    '  constructor(private readonly rows: unknown[]) {',
    '    super();',
    '  }',
    '',
    '  visibleRows(): unknown[] {',
    '    return this.rows;',
    '  }',
    '}',
    '',
    'export function createTreeTableModel(rows: unknown[]): TreeTableModel {',
    '  return new TreeTableModel(rows);',
    '}',
    '',
  ].join('\n');

  it('stores code chunks with path, symbol and lines and links search results to the commit', async () => {
    const collectionId = await createCollection('Code');
    const sha = 'd'.repeat(40);
    const source = await app.inject({
      method: 'PUT',
      url: `/api/collections/${collectionId}/source`,
      payload: { kind: 'git', url: 'https://github.com/example/tree', ref: 'main', commit: sha },
    });
    expect(source.statusCode).toBe(200);

    const uploaded = await upload(collectionId, file('packages/table/src/tree.ts', TREE));
    expect(uploaded.statusCode).toBe(202);
    const [document] = uploaded.json<UploadDocumentsResponse>().documents;
    const list = await waitUntilIndexed(collectionId);
    expect(list.items[0]).toMatchObject({ status: 'ready', language: 'typescript' });

    const chunks = (
      await app.inject({ method: 'GET', url: `/api/documents/${document?.id}/chunks` })
    ).json<DocumentChunksResponse>().chunks;
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.headingPath[0]).toBe('packages/table/src/tree.ts');
    expect(chunks.some((chunk) => chunk.symbol === 'class TreeTableModel')).toBe(true);
    for (const chunk of chunks) {
      expect(chunk.startLine).toBe(TREE.slice(0, chunk.startOffset).split('\n').length);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine ?? 0);
    }

    const search = (
      await app.inject({
        method: 'POST',
        url: '/api/retrieval/search',
        payload: { collectionId, query: 'createTreeTableModel', topK: 3 },
      })
    ).json<RetrievalSearchResponse>();
    expect(search.results.length).toBeGreaterThan(0);
    for (const result of search.results) {
      expect(result.path).toBe('packages/table/src/tree.ts');
      expect(result.language).toBe('typescript');
      expect(result.sourceUrl).toBe(
        `https://github.com/example/tree/blob/${sha}/packages/table/src/tree.ts#L${result.startLine}-L${result.endLine}`,
      );
    }

    const collection = (
      await app.inject({ method: 'GET', url: `/api/collections/${collectionId}` })
    ).json<CollectionDto>();
    expect(collection.source).toMatchObject({ kind: 'git', commit: sha });
  });
});
