import type { ApiErrorResponse } from '@raglab/shared';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerErrorHandling } from '../src/http/error-handler.js';
import { AppError, conflict, isUniqueViolation, notFound } from '../src/http/errors.js';
import { idParamsSchema } from '../src/http/schemas.js';
import { uniqueViolation } from './fakes.js';

let app: FastifyInstance | undefined;

/** Minimal app with the central handlers and routes that throw on demand. */
async function start(thrown?: () => unknown): Promise<FastifyInstance> {
  app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
  registerErrorHandling(app);
  app.get('/throw', async () => {
    throw thrown?.();
  });
  app.post(
    '/items/:id',
    {
      schema: {
        params: idParamsSchema,
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: { name: { type: 'string', minLength: 1 } },
        },
      },
    },
    async () => ({ ok: true }),
  );
  await app.ready();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const VALID_ID = '0195f2a0-0000-7000-8000-000000000000';

describe('error handler', () => {
  it('maps body validation errors to 400 VALIDATION_ERROR with details', async () => {
    const api = await start();

    const response = await api.inject({
      method: 'POST',
      url: `/items/${VALID_ID}`,
      payload: { name: '', extra: true },
    });

    expect(response.statusCode).toBe(400);
    const { error } = response.json<ApiErrorResponse>();
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toBe('Invalid request body');
    expect(error.details).toEqual(
      expect.arrayContaining([{ location: 'body/extra', message: expect.any(String) }]),
    );
  });

  it('rejects a malformed UUID path parameter with 400, not 500', async () => {
    const api = await start();

    const response = await api.inject({
      method: 'POST',
      url: '/items/not-a-uuid',
      payload: { name: 'x' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ApiErrorResponse>().error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Invalid request params',
      details: [{ location: 'params/id', message: expect.stringContaining('uuid') }],
    });
  });

  it('answers unknown routes with 404 ROUTE_NOT_FOUND', async () => {
    const api = await start();

    const response = await api.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.json<ApiErrorResponse>()).toEqual({
      error: { code: 'ROUTE_NOT_FOUND', message: 'Route GET /nope not found' },
    });
  });

  it('passes AppErrors through with status, code, message and details', async () => {
    const api = await start(() => conflict('THING_TAKEN', 'Thing is taken', { name: 'x' }));

    const response = await api.inject({ method: 'GET', url: '/throw' });

    expect(response.statusCode).toBe(409);
    expect(response.json<ApiErrorResponse>()).toEqual({
      error: { code: 'THING_TAKEN', message: 'Thing is taken', details: { name: 'x' } },
    });
  });

  it('omits details when an AppError has none', async () => {
    const api = await start(() => notFound('THING_NOT_FOUND', 'Thing does not exist'));

    const response = await api.inject({ method: 'GET', url: '/throw' });

    expect(response.statusCode).toBe(404);
    expect(response.json<ApiErrorResponse>().error).not.toHaveProperty('details');
  });

  it('maps unhandled unique violations (23505) to 409 CONFLICT', async () => {
    const api = await start(
      () => new DrizzleQueryError('insert into x', ['secret'], uniqueViolation('x_unique')),
    );

    const response = await api.inject({ method: 'GET', url: '/throw' });

    expect(response.statusCode).toBe(409);
    expect(response.json<ApiErrorResponse>().error.code).toBe('CONFLICT');
    expect(response.body).not.toContain('secret');
  });

  it('maps an unreachable database to 503 DATABASE_UNAVAILABLE', async () => {
    const api = await start(() =>
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
    );

    const response = await api.inject({ method: 'GET', url: '/throw' });

    expect(response.statusCode).toBe(503);
    expect(response.json<ApiErrorResponse>().error.code).toBe('DATABASE_UNAVAILABLE');
    expect(response.body).not.toContain('5432');
  });

  it('answers unexpected errors with 500 INTERNAL_ERROR without internals', async () => {
    const api = await start(() => new Error('relation "secret_table" does not exist at /src/x.ts'));

    const response = await api.inject({ method: 'GET', url: '/throw' });

    expect(response.statusCode).toBe(500);
    const { error } = response.json<ApiErrorResponse>();
    expect(error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      details: { requestId: expect.any(String) },
    });
    expect(response.body).not.toContain('secret_table');
    expect(response.body).not.toContain('/src/');
  });

  it('keeps Fastify client errors (invalid JSON) in the error format', async () => {
    const api = await start();

    const response = await api.inject({
      method: 'POST',
      url: `/items/${VALID_ID}`,
      headers: { 'content-type': 'application/json' },
      payload: '{"name":',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ApiErrorResponse>().error.code).toBe('BAD_REQUEST');
  });

  it('maps unsupported media types to 415', async () => {
    const api = await start();

    const response = await api.inject({
      method: 'POST',
      url: `/items/${VALID_ID}`,
      headers: { 'content-type': 'application/xml' },
      payload: '<name/>',
    });

    expect(response.statusCode).toBe(415);
    expect(response.json<ApiErrorResponse>().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });
});

describe('isUniqueViolation', () => {
  it('detects wrapped driver errors and filters by constraint', () => {
    const wrapped = new DrizzleQueryError('q', [], uniqueViolation('a_unique'));

    expect(isUniqueViolation(wrapped)).toBe(true);
    expect(isUniqueViolation(wrapped, 'a_unique')).toBe(true);
    expect(isUniqueViolation(wrapped, 'b_unique')).toBe(false);
    expect(isUniqueViolation(new AppError(409, 'X', 'x'))).toBe(false);
  });
});
