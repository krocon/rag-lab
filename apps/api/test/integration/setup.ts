import pg from 'pg';
import { loadEnvFile } from '../../src/config/load-env-file.js';
import { resolveTestDatabase } from './test-database.js';

/**
 * Shared helpers for integration tests. They need a reachable PostgreSQL with pgvector,
 * e.g. `pnpm db:up`. The database is a dedicated test database – TEST_DATABASE_URL or
 * `<DATABASE_URL name>_test`, created by global-setup.ts – never the development database
 * (see test-database.ts).
 *
 * Warning: the tests TRUNCATE the domain tables of that database.
 */
export function integrationDatabaseUrl(): string {
  loadEnvFile();
  return resolveTestDatabase(process.env).url;
}

export function createTestPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 2 });
}

/** Empties all domain tables so tests do not depend on each other. */
export async function resetDatabase(pool: pg.Pool): Promise<void> {
  // Second line of defence next to resolveTestDatabase: never empty a non-test database.
  const current = await pool.query<{ name: string }>('SELECT current_database() AS name');
  const name = current.rows[0]?.name ?? '';
  if (!/test/i.test(name)) {
    throw new Error(`Refusing to empty the tables of database "${name}" (name without "test").`);
  }
  await pool.query('TRUNCATE collections, documents, chunks CASCADE');
}

/** Inserts a document directly via SQL (upload arrives with prompt 004). Returns its id. */
export async function insertDocument(
  pool: pg.Pool,
  collectionId: string,
  overrides: { contentSha256?: string; status?: string; chunkCount?: number } = {},
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO documents (collection_id, filename, mime_type, size_bytes, content_sha256, content, status, chunk_count)
     VALUES ($1, 'guide.md', 'text/markdown', 12, $2, '# Guide\nHello', $3, $4)
     RETURNING id`,
    [
      collectionId,
      overrides.contentSha256 ?? 'a'.repeat(64),
      overrides.status ?? 'ready',
      overrides.chunkCount ?? 0,
    ],
  );
  return firstRow(result.rows).id;
}

/** Inserts a chunk directly via SQL (bypassing the chunker). Returns its id. */
export async function insertChunk(
  pool: pg.Pool,
  documentId: string,
  collectionId: string,
  chunkIndex: number,
  content = 'Hello',
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO chunks (document_id, collection_id, chunk_index, content, start_offset, end_offset, char_count)
     VALUES ($1, $2, $3, $4, 0, $5, $5)
     RETURNING id`,
    [documentId, collectionId, chunkIndex, content, content.length],
  );
  return firstRow(result.rows).id;
}

export async function count(pool: pg.Pool, table: 'collections' | 'documents' | 'chunks') {
  const result = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`);
  return firstRow(result.rows).count;
}

function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error('query returned no row');
  }
  return row;
}
