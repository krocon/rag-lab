import type { LoggerOptions } from 'pino';
import type { AppConfig } from './config/env.js';

/** Replacement for redacted values in log output. */
export const REDACTED = '[REDACTED]';

/**
 * Log paths that may carry credentials. Fastify's request serializer does not log headers today;
 * the header paths are defence in depth for custom log calls (`{ req }`, `{ headers }`). Config
 * paths cover objects such as `config.database` should anyone log them (DATABASE_URL contains the
 * database password). Wildcards match one level (`*.password` → `{ db: { password } }`).
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["proxy-authorization"]',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["proxy-authorization"]',
  'headers["x-api-key"]',
  'config.database.url',
  'database.url',
  'databaseUrl',
  'DATABASE_URL',
  'apiKey',
  '*.apiKey',
  'password',
  '*.password',
  'token',
  '*.token',
];

/**
 * pino options shared by the HTTP server and background jobs (main.ts) and by `buildApp` when no
 * logger instance is passed. Content (documents, queries, answers) is never logged at info level;
 * see docs/security.md.
 */
export function loggerOptions(config: Pick<AppConfig, 'logLevel'>): LoggerOptions {
  return {
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: REDACTED },
  };
}
