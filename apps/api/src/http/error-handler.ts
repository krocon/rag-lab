import type { FastifyError, FastifyInstance } from 'fastify';
import type { ApiErrorResponse, ValidationIssue } from '@raglab/shared';
import { AppError, findPgError, loggableError, PG_UNIQUE_VIOLATION } from './errors.js';

const CLIENT_ERROR_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  406: 'NOT_ACCEPTABLE',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'TOO_MANY_REQUESTS',
};

/** Node/pg errors that mean "the database is not reachable right now". */
const UNAVAILABLE_NODE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET']);

function body(code: string, message: string, details?: unknown): ApiErrorResponse {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

function isDatabaseUnavailable(error: unknown): boolean {
  const pgError = findPgError(error);
  // SQLSTATE class 08 = connection exception, 57P0x = server shutting down / not accepting connections.
  if (pgError && (pgError.code.startsWith('08') || pgError.code.startsWith('57P0'))) {
    return true;
  }
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && UNAVAILABLE_NODE_CODES.has(code)) {
      return true;
    }
    // AggregateError (e.g. ECONNREFUSED for IPv4 + IPv6) keeps the code on its members.
    if (current instanceof AggregateError) {
      return current.errors.some((member) => isDatabaseUnavailable(member));
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function toValidationIssues(error: FastifyError): ValidationIssue[] {
  const context = error.validationContext ?? 'request';
  return (error.validation ?? []).map((issue) => {
    const missing = issue.params['missingProperty'];
    const extra = issue.params['additionalProperty'];
    const path =
      issue.instancePath +
      (typeof missing === 'string' ? `/${missing}` : '') +
      (typeof extra === 'string' ? `/${extra}` : '');
    const message =
      typeof extra === 'string'
        ? `must not have additional property '${extra}'`
        : (issue.message ?? 'is invalid');
    return { location: `${context}${path}`, message };
  });
}

/**
 * Installs the central error and not-found handlers. Every error response has the shape
 * `{ error: { code, message, details? } }`; unexpected errors never expose internals.
 * Must be called before routes are registered so that all child plugins inherit it.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .send(body('ROUTE_NOT_FOUND', `Route ${request.method} ${request.url} not found`));
  });

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send(body(error.code, error.message, error.details));
    }

    if (error.validation) {
      return reply
        .code(400)
        .send(
          body(
            'VALIDATION_ERROR',
            error.validationContext
              ? `Invalid request ${error.validationContext}`
              : 'Invalid request',
            toValidationIssues(error),
          ),
        );
    }

    if (findPgError(error)?.code === PG_UNIQUE_VIOLATION) {
      return reply.code(409).send(body('CONFLICT', 'The resource conflicts with an existing one'));
    }

    if (isDatabaseUnavailable(error)) {
      request.log.warn({ code: findPgError(error)?.code }, 'database unavailable');
      return reply
        .code(503)
        .send(body('DATABASE_UNAVAILABLE', 'The database is currently not reachable'));
    }

    // Client errors raised by Fastify itself (invalid JSON, unsupported media type, body too large …).
    const statusCode = error.statusCode;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      return reply
        .code(statusCode)
        .send(body(CLIENT_ERROR_CODES[statusCode] ?? 'BAD_REQUEST', error.message));
    }

    // Unexpected: log the cause (with request id via request.log), answer without internals.
    // Drizzle query errors carry SQL parameters (possibly document content) – log only the cause.
    request.log.error({ err: loggableError(error) }, 'unhandled error');
    return reply
      .code(500)
      .send(
        body('INTERNAL_ERROR', 'An unexpected error occurred', { requestId: String(request.id) }),
      );
  });
}
