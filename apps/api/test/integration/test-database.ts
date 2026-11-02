import pg from 'pg';

/**
 * Which database the integration tests use – and the guard that keeps them away from the
 * development database. The tests TRUNCATE all domain tables, so they must never run against the
 * database in DATABASE_URL.
 *
 * - `TEST_DATABASE_URL` set → that database.
 * - otherwise → the server of `DATABASE_URL` with the database name `<name>_test`
 *   (e.g. `raglab` → `raglab_test`); `ensureTestDatabase` creates it if it is missing.
 *
 * Refused (error before anything is touched): a database name without `test`, or the same
 * database as `DATABASE_URL`.
 */
export interface TestDatabaseTarget {
  url: string;
  databaseName: string;
  source: 'TEST_DATABASE_URL' | 'derived from DATABASE_URL';
}

const TEST_NAME = /test/i;
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export function resolveTestDatabase(env: NodeJS.ProcessEnv): TestDatabaseTarget {
  const explicit = env['TEST_DATABASE_URL']?.trim() || undefined;
  const base = env['DATABASE_URL']?.trim() || undefined;
  if (!explicit && !base) {
    throw new Error(
      'Neither TEST_DATABASE_URL nor DATABASE_URL is set – copy .env.example to .env or export one of them.',
    );
  }

  let target: TestDatabaseTarget;
  if (explicit) {
    target = { url: explicit, databaseName: databaseName(explicit), source: 'TEST_DATABASE_URL' };
  } else {
    const url = new URL(base as string);
    const name = `${databaseName(url.href)}_test`;
    url.pathname = `/${encodeURIComponent(name)}`;
    target = { url: url.href, databaseName: name, source: 'derived from DATABASE_URL' };
  }

  if (!TEST_NAME.test(target.databaseName)) {
    throw new Error(
      `Refusing to run integration tests against database "${target.databaseName}" ` +
        `(${target.source}): the tests empty all domain tables, so the database name must ` +
        'contain "test" (e.g. raglab_test).',
    );
  }
  if (base && sameDatabase(target.url, base)) {
    throw new Error(
      `Refusing to run integration tests against the database of DATABASE_URL ("${target.databaseName}"): ` +
        'the tests empty all domain tables. Point TEST_DATABASE_URL to a separate database or unset it ' +
        '(then <name>_test is used).',
    );
  }
  return target;
}

/** Database name of a `postgres://` URL (decoded path without the leading slash). */
export function databaseName(url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!name) {
    throw new Error('The database URL has no database name.');
  }
  return name;
}

/** Same server (host + port) and same database name. */
export function sameDatabase(a: string, b: string): boolean {
  const left = new URL(a);
  const right = new URL(b);
  return (
    left.hostname.toLowerCase() === right.hostname.toLowerCase() &&
    (left.port || '5432') === (right.port || '5432') &&
    databaseName(a) === databaseName(b)
  );
}

/**
 * Creates the test database if it does not exist (needs the CREATEDB privilege, which the
 * Docker Compose user has). Connects to the `postgres` maintenance database of the same server,
 * falling back to `fallbackUrl` (DATABASE_URL) if that is not allowed.
 */
export async function ensureTestDatabase(
  target: TestDatabaseTarget,
  fallbackUrl?: string,
): Promise<'exists' | 'created'> {
  if (!SAFE_IDENTIFIER.test(target.databaseName)) {
    throw new Error(
      `Cannot create test database "${target.databaseName}" automatically (only letters, digits ` +
        'and underscores are supported). Create it manually.',
    );
  }
  const maintenance = new URL(target.url);
  maintenance.pathname = '/postgres';
  const candidates = [maintenance.href, ...(fallbackUrl ? [fallbackUrl] : [])];

  let lastError: unknown;
  for (const url of candidates) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      continue;
    }
    try {
      const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
        target.databaseName,
      ]);
      if (existing.rowCount) {
        return 'exists';
      }
      await client.query(`CREATE DATABASE "${target.databaseName}"`);
      return 'created';
    } finally {
      await client.end();
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `Cannot connect to PostgreSQL to prepare the test database "${target.databaseName}": ${reason}. ` +
      'Start it with "pnpm db:up".',
  );
}
