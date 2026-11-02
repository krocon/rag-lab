import type { FastifyInstance } from 'fastify';
import type { LivenessResponse, ReadinessResponse, SystemInfoResponse } from '@raglab/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { DatabaseProbe } from '../src/db/probe.js';
import { testConfig } from './helpers.js';

const healthyProbe: DatabaseProbe = {
  check: async () => ({
    database: { status: 'up', latencyMs: 1 },
    pgvector: { status: 'up', version: '0.8.7' },
  }),
};

const unreachableProbe: DatabaseProbe = {
  check: async () => ({
    database: { status: 'down', error: 'connect ECONNREFUSED' },
    pgvector: { status: 'down', error: 'database unreachable' },
  }),
};

let app: FastifyInstance | undefined;

async function start(probe: DatabaseProbe): Promise<FastifyInstance> {
  app = await buildApp({ config: testConfig(), probe, logger: false });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /api/health', () => {
  it('reports liveness without touching the database', async () => {
    let probed = false;
    const api = await start({
      check: async () => {
        probed = true;
        return healthyProbe.check();
      },
    });

    const response = await api.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json<LivenessResponse>();
    expect(body).toMatchObject({ status: 'ok', service: 'raglab-api', version: '0.1.0' });
    expect(Date.parse(body.timestamp)).not.toBeNaN();
    expect(probed).toBe(false);
  });
});

describe('GET /api/health/ready', () => {
  it('returns 200 when database and pgvector are up', async () => {
    const api = await start(healthyProbe);

    const response = await api.inject({ method: 'GET', url: '/api/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json<ReadinessResponse>()).toMatchObject({
      status: 'ready',
      checks: { database: { status: 'up' }, pgvector: { status: 'up', version: '0.8.7' } },
    });
  });

  it('returns 503 when the database is unreachable', async () => {
    const api = await start(unreachableProbe);

    const response = await api.inject({ method: 'GET', url: '/api/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json<ReadinessResponse>()).toMatchObject({
      status: 'not_ready',
      checks: { database: { status: 'down' } },
    });
  });

  it('returns 503 when pgvector is missing', async () => {
    const api = await start({
      check: async () => ({
        database: { status: 'up', latencyMs: 2 },
        pgvector: { status: 'down', error: 'extension "vector" not installed' },
      }),
    });

    const response = await api.inject({ method: 'GET', url: '/api/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json<ReadinessResponse>().status).toBe('not_ready');
  });
});

describe('GET /api/system/info', () => {
  it('returns configured providers without secrets', async () => {
    const api = await start(healthyProbe);

    const response = await api.inject({ method: 'GET', url: '/api/system/info' });

    expect(response.statusCode).toBe(200);
    const body = response.json<SystemInfoResponse>();
    expect(body.embedding).toEqual({
      provider: 'ollama',
      model: 'test-embedding-model',
      dimensions: 768,
    });
    expect(body.chat).toEqual({ provider: 'ollama', model: 'test-chat-model' });
    expect(response.body).not.toContain('postgresql://');
  });
});

describe('OpenAPI', () => {
  it('documents the system routes', async () => {
    const api = await start(healthyProbe);

    const response = await api.inject({ method: 'GET', url: '/api/docs/json' });

    expect(response.statusCode).toBe(200);
    const spec = response.json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(['/api/health', '/api/health/ready', '/api/system/info']),
    );
  });
});

describe('CORS', () => {
  it('allows the configured web origin', async () => {
    const api = await start(healthyProbe);

    const response = await api.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://localhost:4200' },
    });

    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:4200');
  });

  it('does not allow unknown origins', async () => {
    const api = await start(healthyProbe);

    const response = await api.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://evil.test' },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
