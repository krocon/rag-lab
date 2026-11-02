// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SeedError, contentTypeFor, normaliseApiUrl, seedDemo } from './seed-lib.mjs';

const API = 'http://api.test:3000';
const FILES = [
  { name: 'a.md', content: '# A\n\nAlpha.' },
  { name: 'b.txt', content: 'Bravo.' },
];
const PROVIDERS_OK = {
  embedding: { model: 'embed-model', reachable: true, modelAvailable: true },
  chat: { model: 'chat-model', reachable: true, modelAvailable: true },
};

/**
 * A fake RAGLab API behind a mocked `fetch`. Documents become `ready` after `readyAfterPolls`
 * list requests following their upload, so the polling loop is exercised.
 */
function fakeApi({
  collections = /** @type {any[]} */ ([]),
  documents = /** @type {any[]} */ ([]),
  providers = /** @type {any} */ (PROVIDERS_OK),
  readyAfterPolls = 1,
  uploadError = /** @type {{ status: number, code: string } | undefined} */ (undefined),
  failNames = /** @type {string[]} */ ([]),
  rateLimitedUploads = 0,
} = {}) {
  /** @type {string[]} */
  const calls = [];
  let nextId = 1;
  let listCount = 0;
  /** @param {number} status @param {unknown} [body] */
  const reply = (status, body) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  /** @type {typeof fetch} */
  const fetchMock = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname;
    calls.push(`${method} ${path}`);
    if (path === '/api/health') return reply(200, { status: 'ok' });
    if (path === '/api/system/providers') return reply(200, providers);
    if (path === '/api/collections' && method === 'GET') return reply(200, { items: collections });
    if (path === '/api/collections' && method === 'POST') {
      const body = JSON.parse(String(init?.body));
      const collection = { id: `c${nextId++}`, embeddingModel: 'embed-model', ...body };
      collections.push(collection);
      return reply(201, collection);
    }
    let match = path.match(/^\/api\/collections\/([^/]+)$/);
    if (match && method === 'DELETE') {
      const id = match[1];
      collections.splice(
        collections.findIndex((c) => c.id === id),
        1,
      );
      documents = documents.filter((d) => d.collectionId !== id);
      return reply(204);
    }
    match = path.match(/^\/api\/collections\/([^/]+)\/documents$/);
    if (match && method === 'GET') {
      listCount++;
      for (const document of documents) {
        if (document.status === 'pending' && listCount - document.uploadedAt > readyAfterPolls) {
          const fails = failNames.includes(document.filename);
          document.status = fails ? 'failed' : 'ready';
          document.chunkCount = fails ? 0 : 2;
          document.errorMessage = fails ? 'Embedding failed in the fake.' : null;
        }
      }
      return reply(200, { items: documents.filter((d) => d.collectionId === match?.[1]) });
    }
    if (match && method === 'POST') {
      if (rateLimitedUploads > 0) {
        rateLimitedUploads--;
        return new Response(
          JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many requests.' } }),
          { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '7' } },
        );
      }
      if (uploadError) {
        return reply(uploadError.status, {
          error: { code: uploadError.code, message: 'rejected by the fake' },
        });
      }
      const form = /** @type {FormData} */ (init?.body);
      const file = /** @type {File} */ (form.get('file'));
      const document = {
        id: `d${nextId++}`,
        collectionId: match[1],
        filename: file.name,
        status: 'pending',
        errorMessage: null,
        chunkCount: 0,
        uploadedAt: listCount,
      };
      documents.push(document);
      return reply(202, { documents: [document] });
    }
    match = path.match(/^\/api\/documents\/([^/]+)\/reindex$/);
    if (match && method === 'POST') {
      const document = documents.find((d) => d.id === match?.[1]);
      Object.assign(document, { status: 'pending', errorMessage: null, uploadedAt: listCount });
      return reply(202, document);
    }
    return reply(404, { error: { code: 'ROUTE_NOT_FOUND', message: 'not found' } });
  };
  return { fetch: fetchMock, calls, collections, getDocuments: () => documents };
}

/** @param {ReturnType<typeof fakeApi>} api @param {Partial<import('./seed-lib.mjs').SeedOptions>} [extra] */
const run = (api, extra = {}) =>
  seedDemo({
    apiUrl: `${API}/`,
    name: 'RAGLab Demo',
    description: 'demo',
    files: FILES,
    fetch: api.fetch,
    sleep: async () => {},
    ...extra,
  });

describe('seedDemo', () => {
  it('creates the collection, uploads every file and waits until all are ready', async () => {
    const api = fakeApi();
    const lines = /** @type {string[]} */ ([]);
    const result = await run(api, { log: (line) => lines.push(line) });

    assert.equal(result.created, true);
    assert.equal(result.collection.name, 'RAGLab Demo');
    assert.deepEqual(result.uploaded, ['a.md', 'b.txt']);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(
      result.documents.map((d) => [d.filename, d.status]),
      [
        ['a.md', 'ready'],
        ['b.txt', 'ready'],
      ],
    );
    // One upload request per file, and at least one poll that still saw pending documents.
    assert.equal(api.calls.filter((c) => c === 'POST /api/collections/c1/documents').length, 2);
    assert.ok(lines.some((line) => line.startsWith('Waiting for indexing')));
    assert.ok(api.calls.includes('GET /api/health'), 'trailing slash of the API URL is removed');
  });

  it('reuses an existing collection (case-insensitive) and uploads nothing twice', async () => {
    const api = fakeApi();
    await run(api);
    const callsBefore = api.calls.length;
    const result = await run(api, { name: 'raglab demo' });

    assert.equal(result.created, false);
    assert.deepEqual(result.uploaded, []);
    assert.deepEqual(result.skipped, ['a.md', 'b.txt']);
    assert.equal(api.collections.length, 1);
    const secondRun = api.calls.slice(callsBefore);
    assert.ok(!secondRun.some((c) => c.startsWith('POST ')), secondRun.join(', '));
  });

  it('uploads only missing files and reindexes failed demo documents', async () => {
    const api = fakeApi({
      collections: [{ id: 'c9', name: 'RAGLab Demo', embeddingModel: 'embed-model' }],
      documents: [
        {
          id: 'd9',
          collectionId: 'c9',
          filename: 'a.md',
          status: 'failed',
          errorMessage: 'Ollama is not reachable.',
          chunkCount: 0,
          uploadedAt: 0,
        },
      ],
    });
    const result = await run(api);

    assert.deepEqual(result.reindexed, ['a.md']);
    assert.deepEqual(result.uploaded, ['b.txt']);
    assert.ok(api.calls.includes('POST /api/documents/d9/reindex'));
    assert.ok(result.documents.every((d) => d.status === 'ready'));
  });

  it('--reset deletes the existing collection and creates it again', async () => {
    const api = fakeApi();
    await run(api);
    const result = await run(api, { reset: true });

    assert.equal(result.deleted, true);
    assert.equal(result.created, true);
    assert.ok(api.calls.includes('DELETE /api/collections/c1'));
    assert.deepEqual(result.uploaded, ['a.md', 'b.txt']);
    assert.equal(api.collections.length, 1);
  });

  it('treats DUPLICATE_DOCUMENT as already present', async () => {
    const api = fakeApi({ uploadError: { status: 409, code: 'DUPLICATE_DOCUMENT' } });
    const result = await run(api);
    assert.deepEqual(result.uploaded, []);
    assert.deepEqual(result.skipped, ['a.md', 'b.txt']);
  });

  it('returns documents that failed to index with their error message', async () => {
    const api = fakeApi({ failNames: ['b.txt'] });
    const result = await run(api);
    const failed = result.documents.filter((d) => d.status === 'failed');
    assert.deepEqual(
      failed.map((d) => [d.filename, d.errorMessage]),
      [['b.txt', 'Embedding failed in the fake.']],
    );
  });
});

describe('seedDemo rate limits', () => {
  it('waits for Retry-After and retries a rate-limited upload', async () => {
    const api = fakeApi({ rateLimitedUploads: 2 });
    const waits = /** @type {number[]} */ ([]);
    const result = await run(api, { sleep: async (ms) => void waits.push(ms) });
    assert.deepEqual(result.uploaded, ['a.md', 'b.txt']);
    assert.deepEqual(waits.slice(0, 2), [7000, 7000]);
  });

  it('gives up after maxRateLimitRetries', async () => {
    const api = fakeApi({ rateLimitedUploads: 10 });
    await assert.rejects(run(api, { maxRateLimitRetries: 2 }), /429 RATE_LIMITED/);
  });
});

describe('seedDemo errors', () => {
  it('reports an unreachable API clearly', async () => {
    await assert.rejects(
      run({
        ...fakeApi(),
        fetch: async () => {
          throw new TypeError('fetch failed');
        },
      }),
      (error) =>
        error instanceof SeedError &&
        /not reachable at http:\/\/api\.test:3000 \(fetch failed\)/.test(error.message) &&
        /pnpm dev/.test(error.message),
    );
  });

  it('reports an unreachable embedding provider (Ollama) before creating anything', async () => {
    const api = fakeApi({
      providers: {
        embedding: { model: 'embed-model', reachable: false, modelAvailable: null, error: 'down' },
        chat: { model: 'chat-model', reachable: false, modelAvailable: null },
      },
    });
    await assert.rejects(run(api), /embedding provider is not reachable.*\(down\).*Ollama/s);
    assert.ok(!api.calls.some((c) => c.startsWith('POST ')));
  });

  it('reports a missing embedding model with the pull hint', async () => {
    const api = fakeApi({
      providers: {
        embedding: { model: 'embed-model', reachable: true, modelAvailable: false },
        chat: PROVIDERS_OK.chat,
      },
    });
    await assert.rejects(run(api), /"embed-model" is not installed.*ollama pull embed-model/);
  });

  it('only notes a missing chat model and still seeds', async () => {
    const api = fakeApi({
      providers: {
        embedding: PROVIDERS_OK.embedding,
        chat: { model: 'chat-model', reachable: true, modelAvailable: false },
      },
    });
    const lines = /** @type {string[]} */ ([]);
    const result = await run(api, { log: (line) => lines.push(line) });
    assert.equal(result.uploaded.length, 2);
    assert.ok(lines.some((line) => line.includes('ollama pull chat-model')));
  });

  it('refuses to reuse a collection embedded with another model', async () => {
    const api = fakeApi({
      collections: [{ id: 'c9', name: 'RAGLab Demo', embeddingModel: 'old-model' }],
    });
    await assert.rejects(run(api), /embedded with "old-model".*--reset/);
  });

  it('passes API error codes through', async () => {
    const api = fakeApi({ uploadError: { status: 415, code: 'UNSUPPORTED_FILE_TYPE' } });
    await assert.rejects(
      run(api),
      (error) =>
        error instanceof SeedError &&
        error.status === 415 &&
        error.code === 'UNSUPPORTED_FILE_TYPE' &&
        /415 UNSUPPORTED_FILE_TYPE: rejected by the fake/.test(error.message),
    );
  });

  it('stops waiting after the timeout', async () => {
    const api = fakeApi({ readyAfterPolls: Number.POSITIVE_INFINITY });
    await assert.rejects(run(api, { timeoutMs: 0 }), /did not finish within 0 s/);
  });

  it('rejects an empty file list and invalid URLs', async () => {
    await assert.rejects(run(fakeApi(), { files: [] }), /No demo files/);
    await assert.rejects(run(fakeApi(), { apiUrl: 'ftp://x' }), /only http and https/);
    await assert.rejects(run(fakeApi(), { apiUrl: 'not a url' }), /Invalid API URL/);
  });
});

describe('helpers', () => {
  it('derives the content type from the extension', () => {
    assert.equal(contentTypeFor('notes.TXT'), 'text/plain');
    assert.equal(contentTypeFor('guide.md'), 'text/markdown');
  });

  it('normalises the API URL', () => {
    assert.equal(normaliseApiUrl('http://localhost:3000/'), 'http://localhost:3000');
    assert.equal(normaliseApiUrl('http://localhost:8080'), 'http://localhost:8080');
  });
});
