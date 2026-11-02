import type { ApiErrorResponse } from '@raglab/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { describe, expect, it } from 'vitest';
import { ROUTE_RATE_LIMITS } from '../../src/http/security.js';
import { createFakeChatProvider } from '../fakes/fake-chat-provider.js';
import { multipart } from '../multipart.js';
import { addReadyChunk, startApp } from './setup.js';

const LOW_LIMITS = {
  RATE_LIMIT_MAX: '3',
  RATE_LIMIT_UPLOAD_MAX: '1',
  RATE_LIMIT_CHAT_MAX: '1',
  RATE_LIMIT_SEARCH_MAX: '2',
};

function expectRateLimited(
  response: Awaited<ReturnType<FastifyInstance['inject']>>,
  limit: number,
) {
  expect(response.statusCode).toBe(429);
  const { error } = response.json<ApiErrorResponse>();
  expect(error.code).toBe('RATE_LIMITED');
  expect(error.message).toMatch(/^Too many requests\. Try again in /);
  expect(error.details).toMatchObject({ limit });
  expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
  expect(response.headers['x-ratelimit-limit']).toBe(String(limit));
  expect(response.headers['x-ratelimit-remaining']).toBe('0');
  // Still a normal API response: security headers, no stack trace.
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.body).not.toMatch(/at .*\.(ts|js):\d+/);
}

describe('rate limits', () => {
  it('limit every route globally (RATE_LIMIT_MAX) with 429 RATE_LIMITED and Retry-After', async () => {
    const { api } = await startApp({ env: LOW_LIMITS });

    for (let attempt = 1; attempt <= 3; attempt++) {
      const response = await api.inject({ method: 'GET', url: '/api/collections' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['x-ratelimit-remaining']).toBe(String(3 - attempt));
    }
    expectRateLimited(await api.inject({ method: 'GET', url: '/api/health' }), 3);
  });

  it('apply stricter, separate limits to upload, chat, retrieval and playground', async () => {
    const { api, collectionId } = await startApp({ env: LOW_LIMITS });
    const requests: Record<string, () => InjectOptions> = {
      'POST /api/collections/:id/documents': () => {
        const { payload, headers } = multipart([
          { filename: `n-${crypto.randomUUID()}.md`, content: `# ${crypto.randomUUID()}` },
        ]);
        return {
          method: 'POST',
          url: `/api/collections/${collectionId}/documents`,
          payload,
          headers,
        };
      },
      'POST /api/chat': () => ({
        method: 'POST',
        url: '/api/chat',
        payload: { collectionId, question: 'Anything?' },
      }),
      'POST /api/retrieval/search': () => ({
        method: 'POST',
        url: '/api/retrieval/search',
        payload: { collectionId, query: 'anything' },
      }),
      'POST /api/playground/search': () => ({
        method: 'POST',
        url: '/api/playground/search',
        payload: { collectionId, query: 'anything' },
      }),
    };
    const limits = { uploadMax: 1, chatMax: 1, searchMax: 2 };

    // Every configured special route is covered by this test.
    expect(Object.keys(requests).sort()).toEqual(
      ROUTE_RATE_LIMITS.map((entry) => `${entry.method} ${entry.url}`).sort(),
    );
    for (const entry of ROUTE_RATE_LIMITS) {
      const build = requests[`${entry.method} ${entry.url}`];
      if (!build) {
        throw new Error(`no request for ${entry.url}`);
      }
      const limit = limits[entry.limit];
      for (let attempt = 0; attempt < limit; attempt++) {
        const response = await api.inject(build());
        expect(response.statusCode, entry.url).toBeLessThan(300);
      }
      expectRateLimited(await api.inject(build()), limit);
    }

    // The special routes have their own counters: the global budget (3) is still untouched.
    expect((await api.inject({ method: 'GET', url: '/api/collections' })).statusCode).toBe(200);
  });

  it('can be disabled (RATE_LIMIT_ENABLED=false)', async () => {
    const { api } = await startApp({ env: { ...LOW_LIMITS, RATE_LIMIT_ENABLED: 'false' } });

    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await api.inject({ method: 'GET', url: '/api/collections' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['x-ratelimit-limit']).toBeUndefined();
    }
  });

  it('document 429 in OpenAPI', async () => {
    const { api } = await startApp();
    await api.ready();
    const spec = api.swagger() as unknown as {
      paths: Record<string, Record<string, { responses: object }>>;
    };

    expect(Object.keys(spec.paths['/api/chat']?.['post']?.responses ?? {})).toContain('429');
    expect(Object.keys(spec.paths['/api/collections']?.['get']?.responses ?? {})).toContain('429');
  });
});

describe('MAX_CONCURRENT_CHATS', () => {
  it('rejects chats beyond the limit with 429 and accepts new ones after a stream ended', async () => {
    const chat = createFakeChatProvider({ tokens: ['a', 'b', 'c'], delayMs: 100 });
    const { api, collectionId, store } = await startApp({
      env: { MAX_CONCURRENT_CHATS: '1' },
      chat,
    });
    // A ready document so that the model is actually called (and the first stream stays open).
    addReadyChunk(store, collectionId, 'RAGLab answers questions.');
    const ask = () =>
      api.inject({
        method: 'POST',
        url: '/api/chat',
        payload: { collectionId, question: 'What does RAGLab do?' },
      });

    const first = ask();
    // Let the first request reach the provider before the second one arrives.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await ask();

    expect(second.statusCode).toBe(429);
    expect(second.headers['retry-after']).toBe('5');
    expect(second.json<ApiErrorResponse>().error).toMatchObject({
      code: 'TOO_MANY_CONCURRENT_CHATS',
      details: { maxConcurrentChats: 1 },
    });
    expect((await first).statusCode).toBe(200);
    expect((await ask()).statusCode).toBe(200);
  });
});
