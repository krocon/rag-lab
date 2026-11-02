import type { FastifyPluginAsync } from 'fastify';
import type { LivenessResponse, ReadinessResponse } from '@raglab/shared';
import type { DatabaseProbe } from '../../db/probe.js';
import { API_VERSION } from '../../version.js';

const componentStatus = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['up', 'down'] },
    latencyMs: { type: 'number' },
    version: { type: 'string' },
    error: { type: 'string' },
  },
} as const;

const readinessSchema = {
  type: 'object',
  required: ['status', 'checks', 'timestamp'],
  properties: {
    status: { type: 'string', enum: ['ready', 'not_ready'] },
    checks: {
      type: 'object',
      required: ['database', 'pgvector'],
      properties: { database: componentStatus, pgvector: componentStatus },
    },
    timestamp: { type: 'string', format: 'date-time' },
  },
} as const;

export const healthRoutes: FastifyPluginAsync<{ probe: DatabaseProbe }> = async (
  app,
  { probe },
) => {
  app.get<{ Reply: LivenessResponse }>(
    '/health',
    {
      schema: {
        tags: ['system'],
        summary: 'Liveness: the API process is running',
        response: {
          200: {
            type: 'object',
            required: ['status', 'service', 'version', 'uptimeSeconds', 'timestamp'],
            properties: {
              status: { type: 'string', const: 'ok' },
              service: { type: 'string', const: 'raglab-api' },
              version: { type: 'string' },
              uptimeSeconds: { type: 'number' },
              timestamp: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
    async () => ({
      status: 'ok',
      service: 'raglab-api',
      version: API_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    }),
  );

  app.get<{ Reply: ReadinessResponse }>(
    '/health/ready',
    {
      schema: {
        tags: ['system'],
        summary: 'Readiness: database and pgvector are usable',
        response: { 200: readinessSchema, 503: readinessSchema },
      },
    },
    async (_request, reply) => {
      const checks = await probe.check();
      const ready = checks.database.status === 'up' && checks.pgvector.status === 'up';
      if (!ready) {
        app.log.warn({ checks }, 'readiness check failed');
      }
      return reply.code(ready ? 200 : 503).send({
        status: ready ? 'ready' : 'not_ready',
        checks,
        timestamp: new Date().toISOString(),
      });
    },
  );
};
