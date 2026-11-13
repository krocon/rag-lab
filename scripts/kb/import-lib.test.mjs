// @ts-check
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ImportError, batchFiles, planImport, runImport } from './import-lib.mjs';
import { contentHash } from './select-lib.mjs';

/** @param {string} path @param {string} content */
const local = (path, content) => ({ path, content, bytes: content.length, hash: contentHash(content) });
/** @param {string | null} path @param {string} content @param {string} [status] */
const remote = (path, content, status = 'ready') => ({
  id: `id-${path ?? content}`,
  path,
  filename: path?.split('/').pop() ?? 'x.md',
  contentSha256: contentHash(content),
  status,
  errorMessage: null,
  chunkCount: 1,
});

describe('planImport', () => {
  const files = [local('a.ts', 'A'), local('b.ts', 'B2'), local('c.ts', 'C'), local('d.ts', 'D')];
  const documents = [
    remote('a.ts', 'A'),
    remote('b.ts', 'B1'),
    remote('gone.ts', 'G'),
    remote(null, 'web upload'),
    remote('d-old.ts', 'D'),
    remote('e.ts', 'E', 'failed'),
  ];

  it('without sync: uploads new files only, deletes and replaces nothing', () => {
    const plan = planImport([...files, local('e.ts', 'E')], documents);
    assert.deepEqual(plan.upload.map((f) => f.path), ['c.ts']);
    assert.deepEqual(plan.unchanged.map((f) => f.path), ['a.ts', 'e.ts']);
    assert.deepEqual(plan.changed.map((c) => c.file.path), ['b.ts']);
    assert.deepEqual(plan.removed.map((d) => d.path), ['d-old.ts', 'gone.ts']);
    // `d.ts` has the content of `d-old.ts`, which stays without --sync.
    assert.deepEqual(plan.duplicateInCollection.map((d) => d.file.path), ['d.ts']);
    assert.deepEqual(plan.reindex.map((d) => d.path), ['e.ts']);
  });

  it('with sync: also uploads changed files and content of deleted documents', () => {
    const plan = planImport(files, documents, { sync: true });
    assert.deepEqual(plan.upload.map((f) => f.path), ['b.ts', 'c.ts', 'd.ts']);
    assert.deepEqual(plan.removed.map((d) => d.path), ['d-old.ts', 'e.ts', 'gone.ts']);
    assert.deepEqual(plan.duplicateInCollection, []);
  });

  it('never touches documents without a path', () => {
    const plan = planImport([], documents, { sync: true });
    assert.ok(!plan.removed.some((document) => document.path === null));
  });
});

describe('batchFiles', () => {
  it('respects the file count and the request size', () => {
    const files = [5, 5, 5, 20, 1, 1, 1].map((bytes, index) => ({ bytes, index }));
    assert.deepEqual(
      batchFiles(files, { maxFiles: 3, maxRequestBytes: 20 }).map((batch) => batch.map((f) => f.index)),
      [[0, 1, 2], [3], [4, 5, 6]],
    );
    assert.deepEqual(batchFiles([], { maxFiles: 3, maxRequestBytes: 20 }), []);
  });
});

/**
 * A fake RAGLab API behind a mocked `fetch`: collections, documents with paths, upload limits,
 * rate limiting and per-file rejection. Documents become `ready` on the next list request.
 */
function fakeApi({ maxFiles = 2, rateLimitFirstUpload = false, rejectPaths = /** @type {string[]} */ ([]) } = {}) {
  /** @type {string[]} */
  const calls = [];
  /** @type {any[]} */
  const collections = [];
  /** @type {any[]} */
  let documents = [];
  /** @type {any} */
  let source = null;
  let nextId = 1;
  let rateLimited = !rateLimitFirstUpload;
  /** @param {number} status @param {unknown} [body] @param {Record<string, string>} [headers] */
  const reply = (status, body, headers = {}) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  /** @type {typeof fetch} */
  const fetchMock = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname;
    calls.push(`${method} ${path}`);
    if (path === '/api/health') return reply(200, { status: 'ok' });
    if (path === '/api/system/info') {
      return reply(200, {
        upload: {
          maxFiles,
          maxFileBytes: 1024 * 1024,
          maxRequestBytes: 10 * 1024 * 1024,
          maxDocumentsPerCollection: null,
          allowedExtensions: ['.md', '.ts', '.json'],
        },
      });
    }
    if (path === '/api/system/providers') {
      return reply(200, { embedding: { model: 'embed', reachable: true, modelAvailable: true } });
    }
    if (path === '/api/collections' && method === 'GET') return reply(200, { items: collections });
    if (path === '/api/collections' && method === 'POST') {
      const body = JSON.parse(String(init?.body));
      const collection = { id: `c${nextId++}`, name: body.name, embeddingModel: 'embed' };
      collections.push(collection);
      return reply(201, collection);
    }
    const docs = /^\/api\/collections\/([^/]+)\/documents$/.exec(path);
    if (docs && method === 'GET') {
      for (const document of documents) document.status = 'ready';
      return reply(200, { items: documents, total: documents.length });
    }
    if (docs && method === 'POST') {
      if (!rateLimited) {
        rateLimited = true;
        return reply(429, { error: { code: 'RATE_LIMITED', message: 'slow down' } }, { 'retry-after': '1' });
      }
      const form = /** @type {FormData} */ (init?.body);
      const paths = form.getAll('path').map(String);
      const files = /** @type {File[]} */ (form.getAll('file'));
      if (files.length > maxFiles) return reply(413, { error: { code: 'TOO_MANY_FILES', message: 'x' } });
      const rejected = paths.find((p) => rejectPaths.includes(p));
      if (rejected) {
        return reply(400, { error: { code: 'INVALID_ENCODING', message: `"${rejected}" is bad` } });
      }
      const added = [];
      for (const [index, file] of files.entries()) {
        const content = await file.text();
        const document = {
          id: `d${nextId++}`,
          path: paths[index],
          filename: file.name,
          contentSha256: contentHash(content),
          status: 'pending',
          errorMessage: null,
          chunkCount: 1,
        };
        added.push(document);
      }
      documents.push(...added);
      return reply(202, { documents: added });
    }
    const document = /^\/api\/documents\/([^/]+)$/.exec(path);
    if (document && method === 'DELETE') {
      documents = documents.filter((d) => d.id !== document[1]);
      return reply(204);
    }
    if (/\/source$/.test(path) && method === 'PUT') {
      source = JSON.parse(String(init?.body));
      return reply(200, { ...collections[0], source });
    }
    return reply(404, { error: { code: 'NOT_FOUND', message: path } });
  };
  return {
    fetch: fetchMock,
    calls,
    get documents() {
      return documents;
    },
    get source() {
      return source;
    },
  };
}

describe('runImport', () => {
  /** @type {string} */
  let root;
  /** @param {string} path @param {string} content */
  const put = async (path, content) => {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  };
  const quiet = { sleep: async () => {}, log: () => {}, pollIntervalMs: 0 };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'raglab-import-'));
    await put('README.md', '# Project\n');
    await put('src/a.ts', 'export const a = 1;\n');
    await put('src/b.ts', 'export const b = 2;\n');
    await put('.env', 'TOKEN=secret');
    await put('node_modules/x/index.js', 'x');
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('dry run: selection and summary without any API call', async () => {
    const api = fakeApi();
    const result = await runImport({ source: root, name: 'X', dryRun: true, fetch: api.fetch, ...quiet });
    assert.equal(api.calls.length, 0);
    assert.deepEqual(result.selected.map((f) => f.path), ['README.md', 'src/a.ts', 'src/b.ts']);
    assert.ok(result.skipped.some((f) => f.path === '.env' && f.reason === 'secret'));
    assert.equal(result.source.kind, 'directory');
  });

  it('first import, second run without uploads, --sync replaces and deletes', async () => {
    const api = fakeApi({ maxFiles: 2, rateLimitFirstUpload: true });
    const first = await runImport({ source: root, name: 'Code', fetch: api.fetch, ...quiet });
    assert.deepEqual(first.uploaded, ['README.md', 'src/a.ts', 'src/b.ts']);
    assert.equal(first.created, true);
    // Two batches (MAX_UPLOAD_FILES = 2), the first one retried after 429.
    assert.equal(api.calls.filter((call) => call.startsWith('POST /api/collections/c1/documents')).length, 3);
    assert.deepEqual(api.source, { kind: 'directory', url: null, ref: null, commit: null });
    assert.ok(first.documents?.every((d) => d.status === 'ready'));

    const second = await runImport({ source: root, name: 'code', fetch: api.fetch, ...quiet });
    assert.equal(second.created, false);
    assert.deepEqual(second.uploaded, []);
    assert.equal(second.plan?.unchanged.length, 3);

    await put('src/a.ts', 'export const a = 42;\n');
    await unlink(join(root, 'src', 'b.ts'));
    const withoutSync = await runImport({ source: root, name: 'Code', fetch: api.fetch, ...quiet });
    assert.deepEqual(withoutSync.uploaded, []);
    assert.deepEqual(withoutSync.deleted, []);
    assert.equal(api.documents.length, 3);

    const synced = await runImport({ source: root, name: 'Code', sync: true, fetch: api.fetch, ...quiet });
    assert.deepEqual(synced.replaced, ['src/a.ts']);
    assert.deepEqual(synced.deleted, ['src/b.ts']);
    assert.deepEqual(synced.uploaded, ['src/a.ts']);
    assert.deepEqual(
      api.documents.map((d) => d.path).sort(),
      ['README.md', 'src/a.ts'],
    );
    assert.equal(api.documents.find((d) => d.path === 'src/a.ts')?.contentSha256, contentHash('export const a = 42;\n'));
  });

  it('isolates a rejected file: the rest of its batch is uploaded', async () => {
    const api = fakeApi({ maxFiles: 5, rejectPaths: ['src/a.ts'] });
    const result = await runImport({ source: root, name: 'Code', fetch: api.fetch, ...quiet });
    assert.deepEqual(result.uploaded, ['README.md', 'src/b.ts']);
    assert.deepEqual(result.rejected?.map((r) => [r.path, r.code]), [['src/a.ts', 'INVALID_ENCODING']]);
  });

  it('rejects --ref for directories and unknown sources', async () => {
    await assert.rejects(runImport({ source: root, name: 'X', ref: 'main', dryRun: true }), ImportError);
    await assert.rejects(runImport({ source: join(root, 'missing'), name: 'X', dryRun: true }), ImportError);
  });

  it('reports an unreachable API clearly', async () => {
    /** @type {typeof fetch} */
    const failing = async () => {
      throw new TypeError('fetch failed');
    };
    await assert.rejects(
      runImport({ source: root, name: 'X', fetch: failing, ...quiet }),
      /not reachable at http:\/\/127\.0\.0\.1:3000/,
    );
  });
});

describe('runImport from a Git URL (local file:// repository, tests only)', () => {
  /** @type {string} */
  let repo;
  before(async () => {
    repo = await mkdtemp(join(tmpdir(), 'raglab-import-repo-'));
    const git = (/** @type {string[]} */ ...args) =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo });
    git('init', '--quiet', '--initial-branch=main');
    await mkdir(join(repo, 'src'));
    await writeFile(join(repo, 'src', 'tree.ts'), 'export class Tree {}\n');
    await writeFile(join(repo, 'README.md'), '# Tree\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'init');
  });
  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('clones, imports and records the commit; local file URLs are not stored', async () => {
    const api = fakeApi({ maxFiles: 5 });
    const result = await runImport({
      source: pathToFileURL(repo).href,
      name: 'Repo',
      allowFileUrls: true,
      fetch: api.fetch,
      sleep: async () => {},
      log: () => {},
      pollIntervalMs: 0,
    });
    assert.deepEqual(result.uploaded, ['README.md', 'src/tree.ts']);
    assert.equal(result.source.kind, 'git');
    assert.match(String(result.source.commit), /^[0-9a-f]{40}$/);
    assert.deepEqual(api.source, { kind: 'git', url: null, ref: null, commit: result.source.commit });
  });
});
