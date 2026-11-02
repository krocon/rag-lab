import type { ApiErrorResponse } from '@raglab/shared';
import { describe, expect, it } from 'vitest';
import { multipart } from '../multipart.js';
import { parseSse } from '../sse.js';
import { startApp, UNKNOWN_ID } from './setup.js';

const ALLOWED_ORIGIN = 'http://localhost:4200';
const FOREIGN_ORIGIN = 'https://evil.example';

function expectApiSecurityHeaders(headers: Record<string, unknown>) {
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['cross-origin-resource-policy']).toBe('same-origin');
  expect(headers['content-security-policy']).toBe(
    "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'",
  );
  // HSTS is left to the TLS-terminating reverse proxy.
  expect(headers['strict-transport-security']).toBeUndefined();
}

describe('security headers', () => {
  it('are set on JSON responses, error responses and unknown routes', async () => {
    const { api } = await startApp();

    for (const url of ['/api/health', `/api/collections/${UNKNOWN_ID}`, '/api/nope']) {
      const response = await api.inject({ method: 'GET', url });
      expectApiSecurityHeaders(response.headers);
    }
  });

  it('are set on SSE chat responses (written after reply.hijack)', async () => {
    const { api, collectionId } = await startApp();

    const response = await api.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { collectionId, question: 'Anything?' },
      headers: { origin: ALLOWED_ORIGIN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expectApiSecurityHeaders(response.headers);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(response.headers['x-ratelimit-limit']).toBe('20');
    expect(parseSse(response.body).at(-1)?.event).toBe('done');
  });

  it('give the Swagger UI its own CSP; the UI and the OpenAPI document still load', async () => {
    const { api } = await startApp();

    const page = await api.inject({ method: 'GET', url: '/api/docs/' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(page.headers['x-content-type-options']).toBe('nosniff');

    // Scripts referenced by the page are served from the same origin.
    for (const script of page.body.matchAll(/<script src="([^"]+)"/g)) {
      const src = (script[1] ?? '').replace(/^\.\//, '/api/docs/');
      const asset = await api.inject({ method: 'GET', url: src });
      expect(asset.statusCode, src).toBe(200);
    }
    expect(page.body).not.toMatch(/<script>(?!\s*<\/script>)/);

    const spec = await api.inject({ method: 'GET', url: '/api/docs/json' });
    expect(spec.statusCode).toBe(200);
    expect(spec.json<{ openapi: string }>().openapi).toBe('3.1.0');
  });

  it('API_DOCS_ENABLED=false removes the Swagger UI and the OpenAPI document', async () => {
    const { api } = await startApp({ env: { API_DOCS_ENABLED: 'false' } });

    for (const url of ['/api/docs', '/api/docs/', '/api/docs/json']) {
      const response = await api.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(404);
    }
    expect((await api.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });
});

describe('CORS', () => {
  it('allows configured origins only', async () => {
    const { api } = await startApp();

    const allowed = await api.inject({
      method: 'GET',
      url: '/api/collections',
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();

    const foreign = await api.inject({
      method: 'GET',
      url: '/api/collections',
      headers: { origin: FOREIGN_ORIGIN },
    });
    // The request is answered (CORS is enforced by the browser), but without a CORS grant.
    expect(foreign.statusCode).toBe(200);
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers preflights with restricted methods and headers, not for foreign origins', async () => {
    const { api } = await startApp();

    const preflight = await api.inject({
      method: 'OPTIONS',
      url: '/api/collections',
      headers: {
        origin: ALLOWED_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(preflight.headers['access-control-allow-methods']).toBe(
      'GET, HEAD, POST, PATCH, DELETE',
    );
    expect(preflight.headers['access-control-allow-headers']).toBe('Content-Type, Accept');

    const foreign = await api.inject({
      method: 'OPTIONS',
      url: '/api/collections',
      headers: { origin: FOREIGN_ORIGIN, 'access-control-request-method': 'DELETE' },
    });
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('requests without Origin (curl, scripts) work without CORS headers', async () => {
    const { api } = await startApp();

    const response = await api.inject({ method: 'GET', url: '/api/collections' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('Origin check (CSRF)', () => {
  it('rejects state-changing requests from foreign origins before the handler runs', async () => {
    const { api, store, collectionId } = await startApp();

    const created = await api.inject({
      method: 'POST',
      url: '/api/collections',
      payload: { name: 'Planted' },
      headers: { origin: FOREIGN_ORIGIN },
    });
    expect(created.statusCode).toBe(403);
    expect(created.json<ApiErrorResponse>().error).toMatchObject({
      code: 'ORIGIN_NOT_ALLOWED',
      details: { origin: FOREIGN_ORIGIN },
    });

    // A multipart upload is a "simple" request: browsers send it cross-origin without preflight.
    const { payload, headers } = multipart([{ filename: 'planted.md', content: '# Planted' }]);
    const upload = await api.inject({
      method: 'POST',
      url: `/api/collections/${collectionId}/documents`,
      payload,
      headers: { ...headers, origin: 'null' },
    });
    expect(upload.statusCode).toBe(403);
    expect(store.documents.size).toBe(0);
    expect(store.collections.size).toBe(1);

    const deleted = await api.inject({
      method: 'DELETE',
      url: `/api/collections/${collectionId}`,
      headers: { origin: FOREIGN_ORIGIN },
    });
    expect(deleted.statusCode).toBe(403);
    expect(store.collections.size).toBe(1);
  });

  it('accepts allowed origins, same-origin requests (Swagger UI) and requests without Origin', async () => {
    const { api } = await startApp();

    const cases = [
      { origin: ALLOWED_ORIGIN, host: 'localhost:3000' },
      { origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000' },
      { host: 'localhost:3000' },
    ];
    for (const [index, { origin, host }] of cases.entries()) {
      const response = await api.inject({
        method: 'POST',
        url: '/api/collections',
        payload: { name: `Docs ${index}` },
        headers: { host, ...(origin ? { origin } : {}) },
      });
      expect(response.statusCode, JSON.stringify({ origin, host })).toBe(201);
    }
  });

  it('does not restrict reading requests (CORS decides what a browser may read)', async () => {
    const { api } = await startApp();

    const response = await api.inject({
      method: 'GET',
      url: '/api/collections',
      headers: { origin: FOREIGN_ORIGIN },
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('Host check (DNS rebinding)', () => {
  it('rejects unknown Host headers', async () => {
    const { api } = await startApp();

    for (const host of ['evil.example', 'evil.example:3000', '192.168.1.20:3000']) {
      const response = await api.inject({
        method: 'GET',
        url: '/api/collections',
        headers: { host },
      });
      expect(response.statusCode, host).toBe(403);
      expect(response.json<ApiErrorResponse>().error.code).toBe('HOST_NOT_ALLOWED');
    }
  });

  it('accepts loopback names with any port, configured names and everything with "*"', async () => {
    const { api } = await startApp();
    for (const host of [
      'localhost',
      'localhost:3000',
      '127.0.0.1:8080',
      '[::1]:3000',
      'LOCALHOST.',
    ]) {
      const response = await api.inject({ method: 'GET', url: '/api/health', headers: { host } });
      expect(response.statusCode, host).toBe(200);
    }
    await api.close();

    const custom = await startApp({ env: { ALLOWED_HOSTS: 'raglab.internal' } });
    expect(
      (
        await custom.api.inject({
          method: 'GET',
          url: '/api/health',
          headers: { host: 'raglab.internal' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await custom.api.inject({
          method: 'GET',
          url: '/api/health',
          headers: { host: 'localhost' },
        })
      ).statusCode,
    ).toBe(403);
    await custom.api.close();

    const any = await startApp({ env: { ALLOWED_HOSTS: '*' } });
    expect(
      (
        await any.api.inject({
          method: 'GET',
          url: '/api/health',
          headers: { host: 'evil.example' },
        })
      ).statusCode,
    ).toBe(200);
  });
});
