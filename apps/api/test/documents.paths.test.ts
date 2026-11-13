import type {
  ApiErrorResponse,
  CollectionDto,
  DocumentListResponse,
  UploadDocumentsResponse,
} from '@raglab/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createInMemoryServices, createInMemoryStore, healthyProbe } from './fakes.js';
import { testConfig } from './helpers.js';
import { multipart, type MultipartFieldPart, type MultipartFilePart } from './multipart.js';

/** Upload with paths (`kb:import`), document list filter/paging and the collection source (017). */
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup() {
  const config = testConfig({ MAX_UPLOAD_FILES: '5' });
  const store = createInMemoryStore();
  const services = createInMemoryServices(config, store);
  app = await buildApp({ config, probe: healthyProbe, services, logger: false });
  const collectionId = (await services.collections.create({ name: 'Code' })).id;
  return { app, collectionId };
}

function upload(
  target: FastifyInstance,
  collectionId: string,
  parts: (MultipartFilePart | MultipartFieldPart)[],
) {
  const { payload, headers } = multipart(parts);
  return target.inject({
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

const errorOf = (response: { json: <T>() => T }) => response.json<ApiErrorResponse>().error;

describe('upload with paths', () => {
  it('stores path, display name and language derived from the extension', async () => {
    const { app, collectionId } = await setup();
    const response = await upload(app, collectionId, [
      ...file('packages/table/src/tree.ts', 'export class Tree {}\n'),
      ...file('docs/guide.md', '# Guide\n'),
      // A file without a preceding path field keeps working as before.
      { filename: 'notes.txt', content: 'plain' },
    ]);
    expect(response.statusCode).toBe(202);
    const { documents } = response.json<UploadDocumentsResponse>();
    expect(documents.map(({ filename, path, language, mimeType }) => ({ filename, path, language, mimeType }))).toEqual([
      { filename: 'tree.ts', path: 'packages/table/src/tree.ts', language: 'typescript', mimeType: 'text/typescript' },
      { filename: 'guide.md', path: 'docs/guide.md', language: 'markdown', mimeType: 'text/markdown' },
      { filename: 'notes.txt', path: null, language: 'text', mimeType: 'text/plain' },
    ]);
  });

  it('uses the extension of the path, not of the multipart file name', async () => {
    const { app, collectionId } = await setup();
    const response = await upload(app, collectionId, [
      { field: 'path', value: 'tools/run.exe' },
      { filename: 'run.ts', content: 'x' },
    ]);
    expect(response.statusCode).toBe(415);
    expect(errorOf(response).code).toBe('UNSUPPORTED_FILE_TYPE');
  });

  it.each(['../x.ts', '/abs/x.ts', 'a//b.ts', 'a/\u0007b.ts', 'C:/x.ts', 'a\\b.ts'])(
    'rejects the invalid path %j with 400 INVALID_PATH and stores nothing',
    async (path) => {
      const { app, collectionId } = await setup();
      const response = await upload(app, collectionId, [
        ...file('ok/first.ts', 'const a = 1;'),
        { field: 'path', value: path },
        { filename: 'x.ts', content: 'const b = 2;' },
      ]);
      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('INVALID_PATH');
      expect(response.body).not.toContain('\u0007');
      const list = await app.inject({ method: 'GET', url: `/api/collections/${collectionId}/documents` });
      expect(list.json<DocumentListResponse>().total).toBe(0);
    },
  );

  it('rejects an over-long path field', async () => {
    const { app, collectionId } = await setup();
    const response = await upload(app, collectionId, [
      { field: 'path', value: `${'a/'.repeat(1500)}x.ts` },
      { filename: 'x.ts', content: 'x' },
    ]);
    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('INVALID_PATH');
  });

  it('rejects the same path twice in one request and a path that already exists', async () => {
    const { app, collectionId } = await setup();
    const twice = await upload(app, collectionId, [
      ...file('src/a.ts', 'const a = 1;'),
      ...file('src/a.ts', 'const a = 2;'),
    ]);
    expect(twice.statusCode).toBe(409);
    expect(errorOf(twice)).toMatchObject({ code: 'DUPLICATE_PATH', details: { path: 'src/a.ts' } });

    expect((await upload(app, collectionId, file('src/a.ts', 'const a = 1;'))).statusCode).toBe(202);
    const again = await upload(app, collectionId, file('src/a.ts', 'const a = 3;'));
    expect(again.statusCode).toBe(409);
    expect(errorOf(again)).toMatchObject({
      code: 'DUPLICATE_PATH',
      details: { path: 'src/a.ts', existingDocumentId: expect.any(String) },
    });
  });

  it('applies a path field to the next file only', async () => {
    const { app, collectionId } = await setup();
    const response = await upload(app, collectionId, [
      ...file('src/a.ts', 'const a = 1;'),
      { filename: 'b.ts', content: 'const b = 1;' },
    ]);
    expect(response.json<UploadDocumentsResponse>().documents.map((d) => d.path)).toEqual([
      'src/a.ts',
      null,
    ]);
  });
});

describe('GET /api/collections/:id/documents – filter and paging', () => {
  it('orders by path, filters by literal prefix and pages with a total', async () => {
    const { app, collectionId } = await setup();
    await upload(app, collectionId, [
      ...file('packages/table/src/b.ts', 'const b = 1;'),
      ...file('packages/table/src/a.ts', 'const a = 1;'),
      ...file('packages/table-utils/x.ts', 'const x = 1;'),
      ...file('docs/%_.md', '# Percent'),
      { filename: 'loose.md', content: '# Loose' },
    ]);
    const list = async (query: string) =>
      (
        await app.inject({ method: 'GET', url: `/api/collections/${collectionId}/documents${query}` })
      ).json<DocumentListResponse>();

    const all = await list('');
    expect(all.total).toBe(5);
    expect(all.items.map((d) => d.path)).toEqual([
      'docs/%_.md',
      'packages/table-utils/x.ts',
      'packages/table/src/a.ts',
      'packages/table/src/b.ts',
      null,
    ]);

    const filtered = await list('?pathPrefix=packages/table/');
    expect(filtered.total).toBe(2);
    expect(filtered.items.map((d) => d.path)).toEqual(['packages/table/src/a.ts', 'packages/table/src/b.ts']);

    // The prefix is literal: `%` and `_` are no wildcards.
    expect((await list('?pathPrefix=docs/%25_')).total).toBe(1);
    expect((await list('?pathPrefix=docs/x')).total).toBe(0);

    const page = await list('?limit=2&offset=1');
    expect(page.total).toBe(5);
    expect(page.items.map((d) => d.path)).toEqual(['packages/table-utils/x.ts', 'packages/table/src/a.ts']);
  });

  it('validates the query', async () => {
    const { app, collectionId } = await setup();
    for (const query of ['?limit=0', '?limit=1001', '?offset=-1', '?limit=abc']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/collections/${collectionId}/documents${query}`,
      });
      expect(response.statusCode, query).toBe(400);
      expect(errorOf(response).code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('PUT /api/collections/:id/source', () => {
  it('records the import source and returns it with the collection', async () => {
    const { app, collectionId } = await setup();
    const response = await app.inject({
      method: 'PUT',
      url: `/api/collections/${collectionId}/source`,
      payload: {
        kind: 'git',
        url: 'https://github.com/guiexperttable/mono',
        ref: 'main',
        commit: 'b'.repeat(40),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<CollectionDto>().source).toEqual({
      kind: 'git',
      url: 'https://github.com/guiexperttable/mono',
      ref: 'main',
      commit: 'b'.repeat(40),
      importedAt: expect.any(String),
    });
    const fetched = await app.inject({ method: 'GET', url: `/api/collections/${collectionId}` });
    expect(fetched.json<CollectionDto>().source?.kind).toBe('git');
  });

  it('rejects URLs with credentials without echoing them', async () => {
    const { app, collectionId } = await setup();
    const response = await app.inject({
      method: 'PUT',
      url: `/api/collections/${collectionId}/source`,
      payload: { kind: 'git', url: 'https://user:s3cr3t-token@github.com/o/r' },
    });
    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('INVALID_SOURCE');
    expect(response.body).not.toContain('s3cr3t');
  });

  it('answers 404 for unknown collections and 400 for unknown kinds', async () => {
    const { app, collectionId } = await setup();
    const unknown = await app.inject({
      method: 'PUT',
      url: '/api/collections/0195f2a0-0000-7000-8000-000000000000/source',
      payload: { kind: 'directory' },
    });
    expect(unknown.statusCode).toBe(404);
    const kind = await app.inject({
      method: 'PUT',
      url: `/api/collections/${collectionId}/source`,
      payload: { kind: 'svn' },
    });
    expect(kind.statusCode).toBe(400);
  });
});
