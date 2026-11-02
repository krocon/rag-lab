/**
 * Application errors with a stable, machine-readable `code`.
 *
 * Services throw these (they carry no Fastify dependency); the central error handler
 * (`error-handler.ts`) turns them into `{ error: { code, message, details? } }`.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown): AppError =>
  new AppError(400, code, message, details);

export const notFound = (code: string, message: string, details?: unknown): AppError =>
  new AppError(404, code, message, details);

export const conflict = (code: string, message: string, details?: unknown): AppError =>
  new AppError(409, code, message, details);

/** PostgreSQL SQLSTATE codes the API reacts to. */
export const PG_UNIQUE_VIOLATION = '23505';

interface PgLikeError {
  code: string;
  constraint?: string;
}

/**
 * Finds the PostgreSQL driver error in an error chain. Drizzle wraps driver errors in
 * `DrizzleQueryError` (with the driver error as `cause`).
 */
export function findPgError(error: unknown): PgLikeError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return typeof candidate.constraint === 'string'
        ? { code: candidate.code, constraint: candidate.constraint }
        : { code: candidate.code };
    }
    current = candidate.cause;
  }
  return undefined;
}

/** True for a unique violation, optionally of a specific constraint/index. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pgError = findPgError(error);
  return (
    pgError?.code === PG_UNIQUE_VIOLATION &&
    (constraint === undefined || pgError.constraint === constraint)
  );
}

/**
 * Returns the part of an error that is safe to log. Drizzle wraps driver errors in
 * `DrizzleQueryError`, whose message contains the SQL parameters – potentially document
 * content – so only its `cause` (the driver error) is logged.
 */
export function loggableError(error: unknown): unknown {
  if (error instanceof Error && error.name === 'DrizzleQueryError') {
    return error.cause ?? { name: error.name };
  }
  return error;
}

/** JSON schema of the error body, used in route `response` schemas (→ OpenAPI). */
export const errorResponseSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', description: 'Machine-readable code in UPPER_SNAKE_CASE' },
        message: { type: 'string' },
        details: {},
      },
    },
  },
} as const;
