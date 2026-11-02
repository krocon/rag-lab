import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import {
  count,
  createTestPool,
  insertChunk,
  insertDocument,
  integrationDatabaseUrl,
  resetDatabase,
} from './setup.js';

const databaseUrl = integrationDatabaseUrl();
const pool = createTestPool(databaseUrl);

async function insertCollection(name: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO collections (name, embedding_provider, embedding_model, embedding_dimensions)
     VALUES ($1, 'ollama', 'test-embedding-model', 768) RETURNING id`,
    [name],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('insert failed');
  return id;
}

/** Resolves to the SQLSTATE of the failing statement (or undefined if it succeeds). */
async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

beforeAll(async () => {
  await runMigrations(databaseUrl);
});

beforeEach(async () => {
  await resetDatabase(pool);
});

afterAll(async () => {
  await resetDatabase(pool);
  await pool.end();
});

describe('schema', () => {
  it('creates the tables and the document_status enum', async () => {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('collections', 'documents', 'chunks')`,
    );
    const labels = await pool.query<{ label: string }>(
      `SELECT unnest(enum_range(NULL::document_status))::text AS label`,
    );

    expect(tables.rows.map((row) => row.table_name).sort()).toEqual([
      'chunks',
      'collections',
      'documents',
    ]);
    expect(labels.rows.map((row) => row.label)).toEqual([
      'pending',
      'processing',
      'ready',
      'failed',
    ]);
  });

  it('generates UUIDv7 ids and timestamps by default', async () => {
    const id = await insertCollection('Docs');
    const row = await pool.query<{ version: number; created_at: Date }>(
      'SELECT uuid_extract_version(id) AS version, created_at FROM collections WHERE id = $1',
      [id],
    );

    expect(row.rows[0]?.version).toBe(7);
    expect(row.rows[0]?.created_at).toBeInstanceOf(Date);
  });

  it('declares every foreign key with ON DELETE CASCADE', async () => {
    const result = await pool.query<{
      table_name: string;
      column_name: string;
      delete_rule: string;
    }>(
      `SELECT kcu.table_name, kcu.column_name, rc.delete_rule
       FROM information_schema.referential_constraints rc
       JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = rc.constraint_name
       WHERE kcu.table_name IN ('documents', 'chunks')
       ORDER BY kcu.table_name, kcu.column_name`,
    );

    expect(result.rows).toEqual([
      { table_name: 'chunks', column_name: 'collection_id', delete_rule: 'CASCADE' },
      { table_name: 'chunks', column_name: 'document_id', delete_rule: 'CASCADE' },
      { table_name: 'documents', column_name: 'collection_id', delete_rule: 'CASCADE' },
    ]);
  });

  it('creates the HNSW index with vector_cosine_ops and the filter indexes', async () => {
    const result = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename IN ('collections', 'documents', 'chunks')`,
    );
    const indexes = Object.fromEntries(result.rows.map((row) => [row.indexname, row.indexdef]));

    expect(indexes['chunks_embedding_hnsw_idx']).toMatch(
      /USING hnsw \(embedding vector_cosine_ops\)/,
    );
    expect(indexes['chunks_collection_id_idx']).toContain('(collection_id)');
    expect(indexes['documents_collection_id_status_idx']).toContain('(collection_id, status)');
    expect(indexes['collections_name_lower_unique']).toMatch(/UNIQUE INDEX .*\(lower\(name\)\)/);
  });

  it('stores embeddings as vector(768)', async () => {
    const result = await pool.query<{ type: string }>(
      `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
       WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'`,
    );

    expect(result.rows[0]?.type).toBe('vector(768)');
  });
});

describe('constraints', () => {
  it('makes collection names unique case-insensitively', async () => {
    await insertCollection('Docs');

    expect(await sqlState(insertCollection('docs'))).toBe('23505');
  });

  it('rejects empty and overlong collection names', async () => {
    expect(await sqlState(insertCollection(''))).toBe('23514');
    expect(await sqlState(insertCollection('x'.repeat(121)))).toBe('23514');
  });

  it('makes (collection_id, content_sha256) unique for documents', async () => {
    const first = await insertCollection('A');
    const second = await insertCollection('B');
    await insertDocument(pool, first, { contentSha256: 'f'.repeat(64) });

    expect(await sqlState(insertDocument(pool, first, { contentSha256: 'f'.repeat(64) }))).toBe(
      '23505',
    );
    // The same content may exist in another collection.
    await expect(insertDocument(pool, second, { contentSha256: 'f'.repeat(64) })).resolves.toEqual(
      expect.any(String),
    );
  });

  it('makes (document_id, chunk_index) unique for chunks', async () => {
    const collectionId = await insertCollection('Docs');
    const documentId = await insertDocument(pool, collectionId);
    await insertChunk(pool, documentId, collectionId, 0);

    expect(await sqlState(insertChunk(pool, documentId, collectionId, 0))).toBe('23505');
  });

  it('rejects blank chunk content (CHECK length(trim(content)) > 0)', async () => {
    const collectionId = await insertCollection('Docs');
    const documentId = await insertDocument(pool, collectionId);

    expect(await sqlState(insertChunk(pool, documentId, collectionId, 0, ''))).toBe('23514');
    expect(await sqlState(insertChunk(pool, documentId, collectionId, 1, '   '))).toBe('23514');
  });

  it('rejects embeddings with the wrong dimension', async () => {
    const collectionId = await insertCollection('Docs');
    const documentId = await insertDocument(pool, collectionId);
    const chunkId = await insertChunk(pool, documentId, collectionId, 0);

    const state = await sqlState(
      pool.query(`UPDATE chunks SET embedding = '[1,2,3]' WHERE id = $1`, [chunkId]),
    );

    expect(state).toBe('22000');
  });
});

describe('cascading deletes', () => {
  it('deletes documents and chunks with their collection', async () => {
    const collectionId = await insertCollection('Docs');
    const documentId = await insertDocument(pool, collectionId);
    await insertChunk(pool, documentId, collectionId, 0);
    await insertChunk(pool, documentId, collectionId, 1);

    await pool.query('DELETE FROM collections WHERE id = $1', [collectionId]);

    expect(await count(pool, 'documents')).toBe(0);
    expect(await count(pool, 'chunks')).toBe(0);
  });

  it('deletes chunks with their document', async () => {
    const collectionId = await insertCollection('Docs');
    const documentId = await insertDocument(pool, collectionId);
    await insertChunk(pool, documentId, collectionId, 0);

    await pool.query('DELETE FROM documents WHERE id = $1', [documentId]);

    expect(await count(pool, 'chunks')).toBe(0);
    expect(await count(pool, 'collections')).toBe(1);
  });
});
