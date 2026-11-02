import type { ApiErrorResponse, CollectionDto } from '@raglab/shared';
import type { InjectOptions } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createChatProvider } from '../../src/modules/chat/create-chat-provider.js';
import { createEmbeddingProvider } from '../../src/modules/embeddings/create-embedding-provider.js';
import { createInMemoryServices, healthyProbe } from '../fakes.js';
import { testConfig } from '../helpers.js';
import { multipart } from '../multipart.js';
import { startApp, UNKNOWN_ID } from './setup.js';

/** Every API route: a valid request (shape-wise) and, if it has one, a JSON body. */
interface RouteCase {
  method: InjectOptions['method'] & string;
  url: string;
  body?: Record<string, unknown>;
}

function routeCases(collectionId: string): RouteCase[] {
  return [
    { method: 'GET', url: '/api/health' },
    { method: 'GET', url: '/api/health/ready' },
    { method: 'GET', url: '/api/system/info' },
    { method: 'GET', url: '/api/system/providers' },
    { method: 'GET', url: '/api/collections' },
    { method: 'POST', url: '/api/collections', body: { name: 'New' } },
    { method: 'GET', url: '/api/collections/:id' },
    { method: 'PATCH', url: '/api/collections/:id', body: { name: 'Renamed' } },
    { method: 'DELETE', url: '/api/collections/:id' },
    { method: 'GET', url: '/api/collections/:id/documents' },
    { method: 'POST', url: '/api/collections/:id/documents' },
    { method: 'GET', url: '/api/documents/:id' },
    { method: 'GET', url: '/api/documents/:id/content' },
    { method: 'GET', url: '/api/documents/:id/chunks' },
    { method: 'POST', url: '/api/documents/:id/reindex' },
    { method: 'DELETE', url: '/api/documents/:id' },
    { method: 'POST', url: '/api/chunking/preview', body: { text: 'Hello', format: 'text' } },
    { method: 'POST', url: '/api/retrieval/search', body: { collectionId, query: 'hello' } },
    { method: 'POST', url: '/api/playground/search', body: { collectionId, query: 'hello' } },
    { method: 'POST', url: '/api/chat', body: { collectionId, question: 'hello' } },
  ];
}

const withId = (url: string, id: string) => url.replace(':id', id);

describe('schema strictness (every route)', () => {
  it('the route table covers every operation in the OpenAPI document', async () => {
    const { api, collectionId } = await startApp();
    await api.ready();
    const spec = api.swagger() as {
      paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
    };

    const documented = Object.entries(spec.paths).flatMap(([path, operations]) =>
      Object.keys(operations).map(
        (method) => `${method.toUpperCase()} ${path.replace('{id}', ':id')}`,
      ),
    );
    const tested = routeCases(collectionId).map((route) => `${route.method} ${route.url}`);
    expect(tested.sort()).toEqual(documented.filter((entry) => !entry.startsWith('HEAD')).sort());

    // Every operation documents a success response and the standard error responses.
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const codes = Object.keys(operation.responses ?? {});
        expect(
          codes.some((code) => code.startsWith('2')),
          `${method} ${path}`,
        ).toBe(true);
        expect(codes, `${method} ${path}`).toEqual(expect.arrayContaining(['403', '429', '500']));
      }
    }
  });

  it('rejects unknown query parameters with 400 VALIDATION_ERROR', async () => {
    const { api, collectionId } = await startApp({ env: { RATE_LIMIT_ENABLED: 'false' } });

    for (const route of routeCases(collectionId)) {
      const response = await api.inject({
        method: route.method,
        url: `${withId(route.url, UNKNOWN_ID)}?unexpected=1`,
        ...(route.body ? { payload: route.body } : {}),
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(400);
      expect(response.json<ApiErrorResponse>().error).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [{ location: 'querystring/unexpected' }],
      });
    }
  });

  it('rejects additional body properties with 400 VALIDATION_ERROR', async () => {
    const { api, collectionId } = await startApp({ env: { RATE_LIMIT_ENABLED: 'false' } });

    for (const route of routeCases(collectionId).filter((candidate) => candidate.body)) {
      const response = await api.inject({
        method: route.method,
        url: withId(route.url, collectionId),
        payload: { ...route.body, internal: true },
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(400);
      expect(response.json<ApiErrorResponse>().error.details).toEqual([
        { location: 'body/internal', message: "must not have additional property 'internal'" },
      ]);
    }
  });

  it('rejects malformed ids in every path with 400 VALIDATION_ERROR', async () => {
    const { api, collectionId } = await startApp({ env: { RATE_LIMIT_ENABLED: 'false' } });

    for (const route of routeCases(collectionId).filter((candidate) =>
      candidate.url.includes(':id'),
    )) {
      // Encoded path traversal reaches the route as a parameter and fails the UUID format.
      for (const id of ['not-a-uuid', '..%2F..%2Fetc%2Fpasswd', `${UNKNOWN_ID}%00`]) {
        const response = await api.inject({
          method: route.method,
          url: withId(route.url, id),
          ...(route.body ? { payload: route.body } : {}),
        });
        expect(response.statusCode, `${route.method} ${route.url} ${id}`).toBe(400);
        expect(response.json<ApiErrorResponse>().error.code).toBe('VALIDATION_ERROR');
      }
    }
  });

  it('enforces length and range limits of free-text and numeric fields', async () => {
    const { api, collectionId } = await startApp({ env: { RATE_LIMIT_ENABLED: 'false' } });
    const invalid: [string, Record<string, unknown>][] = [
      ['/api/collections', { name: 'x'.repeat(121) }],
      ['/api/collections', { name: 'ok', description: 'x'.repeat(2001) }],
      ['/api/retrieval/search', { collectionId, query: 'x'.repeat(2001) }],
      ['/api/retrieval/search', { collectionId, query: 'q', topK: 101 }],
      ['/api/retrieval/search', { collectionId, query: 'q', minScore: 2 }],
      ['/api/playground/search', { collectionId, query: 'q', topK: 0 }],
      ['/api/chat', { collectionId, question: 'x'.repeat(2001) }],
      ['/api/chat', { collectionId, question: 'q', topK: 1.5 }],
      ['/api/chunking/preview', { text: 'x', format: 'text', targetSize: 20_001 }],
    ];
    for (const [url, payload] of invalid) {
      const response = await api.inject({ method: 'POST', url, payload });
      expect(response.statusCode, `${url} ${JSON.stringify(payload).slice(0, 80)}`).toBe(400);
    }
  });

  it('response schemas drop internal fields a service might return', async () => {
    const { api, services, collectionId } = await startApp();
    const original = services.collections.get.bind(services.collections);
    services.collections.get = async (id) =>
      ({
        ...(await original(id)),
        embeddingColumn: 'vector(768)',
        internalNote: 'do not ship',
      }) as CollectionDto;

    const response = await api.inject({ method: 'GET', url: `/api/collections/${collectionId}` });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('internalNote');
    expect(response.body).not.toContain('vector(768)');
  });
});

describe('error responses', () => {
  it('never contain stack traces or internals, also with NODE_ENV=production', async () => {
    for (const env of ['production', 'development']) {
      const { api, services } = await startApp({ env: { NODE_ENV: env } });
      services.collections.list = async () => {
        throw new Error('connection to /srv/raglab/secret.sock failed with password hunter2');
      };

      const failed = await api.inject({ method: 'GET', url: '/api/collections' });
      expect(failed.statusCode).toBe(500);
      expect(failed.json<ApiErrorResponse>()).toEqual({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
          details: { requestId: expect.any(String) },
        },
      });

      const invalidJson = await api.inject({
        method: 'POST',
        url: '/api/collections',
        payload: '{"name":',
        headers: { 'content-type': 'application/json' },
      });
      expect(invalidJson.statusCode).toBe(400);

      for (const body of [failed.body, invalidJson.body]) {
        expect(body).not.toContain('stack');
        expect(body).not.toContain('hunter2');
        expect(body).not.toMatch(/\bat .+:\d+:\d+/);
        expect(body).not.toContain('node_modules');
      }
      await api.close();
    }
  });
});

describe('/api/system/* exposes no URLs or credentials', () => {
  it('neither in the configuration info nor in provider errors', async () => {
    const config = testConfig({
      DATABASE_URL: 'postgresql://raglab:DbSecret123@db.internal:5432/raglab',
      OLLAMA_BASE_URL: 'http://admin:OllamaSecret456@ollama.internal:11434',
    });
    // Real Ollama adapters whose transport fails with the URL in the error (like undici does).
    const failingFetch: typeof fetch = async (input) => {
      throw new TypeError('fetch failed', {
        cause: new Error(`connect ECONNREFUSED ${String(input)}`),
      });
    };
    const services = createInMemoryServices(config, undefined, {
      embeddingProvider: createEmbeddingProvider(config, { fetch: failingFetch }),
      chatProvider: createChatProvider(config, { fetch: failingFetch }),
    });
    const api = await buildApp({ config, probe: healthyProbe, services, logger: false });

    try {
      for (const url of [
        '/api/system/info',
        '/api/system/providers',
        '/api/system/providers?verify=true',
      ]) {
        const response = await api.inject({ method: 'GET', url });
        expect(response.statusCode, url).toBe(200);
        for (const secret of [
          'DbSecret123',
          'OllamaSecret456',
          'db.internal',
          'ollama.internal',
          '://',
        ]) {
          expect(response.body, `${url} contains ${secret}`).not.toContain(secret);
        }
      }
    } finally {
      await api.close();
    }
  });
});

describe('upload limits', () => {
  it('cap the total bytes of one request (MAX_UPLOAD_REQUEST_BYTES)', async () => {
    const { api, store, collectionId } = await startApp({
      env: { MAX_UPLOAD_BYTES: '1024', MAX_UPLOAD_FILES: '5', MAX_UPLOAD_REQUEST_BYTES: '2048' },
    });
    const { payload, headers } = multipart(
      ['a', 'b', 'c'].map((name) => ({ filename: `${name}.txt`, content: name.repeat(1000) })),
    );

    const response = await api.inject({
      method: 'POST',
      url: `/api/collections/${collectionId}/documents`,
      payload,
      headers,
    });

    expect(response.statusCode).toBe(413);
    expect(response.json<ApiErrorResponse>().error).toMatchObject({
      code: 'UPLOAD_TOO_LARGE',
      details: { maxRequestBytes: 2048 },
    });
    expect(store.documents.size).toBe(0);
  });
});
