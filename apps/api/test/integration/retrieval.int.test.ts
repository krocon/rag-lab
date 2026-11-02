import type { RetrievalSearchResponse } from '@raglab/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPgProbe } from '../../src/db/probe.js';
import * as schema from '../../src/db/schema.js';
import { toVectorLiteral } from '../../src/db/vector.js';
import {
  createRetrievalRepository,
  searchQuery,
  searchSettingsQuery,
} from '../../src/modules/retrieval/retrieval.repository.js';
import { createRetrievalService } from '../../src/modules/retrieval/retrieval.service.js';
import { createServices, type AppServices } from '../../src/services.js';
import {
  createFakeEmbeddingProvider,
  type FakeEmbeddingProvider,
} from '../fakes/fake-embedding-provider.js';
import { silentLogger, testConfig } from '../helpers.js';
import { insertChunk, insertDocument, integrationDatabaseUrl, resetDatabase } from './setup.js';

const DIMENSIONS = 768;

/** Unit vector e_i. */
function unit(index: number, sign = 1): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  vector[index] = sign;
  return vector;
}

/** `a + factor·b` (not normalised – cosine distance is scale invariant). */
function plus(a: number[], b: number[], factor = 1): number[] {
  return a.map((value, index) => value + factor * (b[index] ?? 0));
}

/** Hand-made query vectors: the fake provider embeds these query texts exactly like this. */
const QUERY_VECTORS: Record<string, number[]> = {
  'query e0': unit(0),
  'query e1': unit(1),
};

const databaseUrl = integrationDatabaseUrl();
const connection = createDatabase(databaseUrl, 4);
const { pool } = connection;
const config = testConfig({ DATABASE_URL: databaseUrl });
const provider: FakeEmbeddingProvider = createFakeEmbeddingProvider({
  dimensions: DIMENSIONS,
  vectorFor: (text) => QUERY_VECTORS[text],
});
let app: FastifyInstance;
let services: AppServices;

beforeAll(async () => {
  await runMigrations(databaseUrl);
  services = createServices(connection.db, config, silentLogger, { embeddingProvider: provider });
  app = await buildApp({
    config,
    probe: createPgProbe(pool, { embeddingDimensions: config.embedding.dimensions }),
    services,
    logger: false,
  });
});

beforeEach(async () => {
  await resetDatabase(pool);
  provider.failWith = undefined;
  provider.calls.length = 0;
});

afterAll(async () => {
  await app.close();
  await resetDatabase(pool);
  await connection.close();
});

async function insertCollection(
  name: string,
  model = config.embedding.model,
  client: pg.Pool = pool,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO collections (name, embedding_provider, embedding_model, embedding_dimensions)
     VALUES ($1, 'ollama', $2, $3) RETURNING id`,
    [name, model, DIMENSIONS],
  );
  return result.rows[0]?.id ?? '';
}

let documentCounter = 0;

async function addDocument(collectionId: string, status = 'ready'): Promise<string> {
  documentCounter++;
  return insertDocument(pool, collectionId, {
    status,
    contentSha256: documentCounter.toString(16).padStart(64, '0'),
  });
}

/** Inserts a chunk with an embedding (or `null`). Returns its id. */
async function addChunk(
  documentId: string,
  collectionId: string,
  chunkIndex: number,
  embedding: number[] | null,
  content = `chunk ${chunkIndex}`,
): Promise<string> {
  const id = await insertChunk(pool, documentId, collectionId, chunkIndex, content);
  if (embedding) {
    await pool.query('UPDATE chunks SET embedding = $1::vector WHERE id = $2', [
      toVectorLiteral(embedding),
      id,
    ]);
  }
  return id;
}

/** Inserts many embedded chunks in one statement (bind parameters, no concatenation). */
async function addChunks(
  client: pg.Pool,
  documentId: string,
  collectionId: string,
  embeddings: number[][],
): Promise<void> {
  await client.query(
    `INSERT INTO chunks (document_id, collection_id, chunk_index, content, start_offset, end_offset, char_count, embedding)
     SELECT $1, $2, t.i, 'chunk ' || t.i, 0, 1, 1, t.v::vector
       FROM unnest($3::int[], $4::text[]) AS t(i, v)`,
    [
      documentId,
      collectionId,
      embeddings.map((_, index) => index),
      embeddings.map((embedding) => toVectorLiteral(embedding)),
    ],
  );
}

async function search(body: object) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/retrieval/search',
    payload: body,
  });
  return { statusCode: response.statusCode, body: response.json<RetrievalSearchResponse>() };
}

describe('POST /api/retrieval/search against PostgreSQL', () => {
  it('returns exact cosine distances and scores in ascending distance order', async () => {
    const collectionId = await insertCollection('Docs');
    const documentId = await addDocument(collectionId);
    // Inserted in a scrambled order on purpose.
    const opposite = await addChunk(documentId, collectionId, 0, unit(0, -1));
    const orthogonal = await addChunk(documentId, collectionId, 1, unit(1));
    const same = await addChunk(documentId, collectionId, 2, unit(0));
    const diagonal = await addChunk(documentId, collectionId, 3, plus(unit(0), unit(1)));

    const { statusCode, body } = await search({ collectionId, query: '  query e0  ' });

    expect(statusCode).toBe(200);
    expect(body.query).toBe('query e0');
    expect(provider.calls).toEqual([['query e0']]);
    expect(body.topK).toBe(config.retrieval.defaultTopK);
    expect(body.minScore).toBeNull();
    expect(body.embedding).toEqual({
      provider: 'ollama',
      model: 'test-embedding-model',
      dimensions: 768,
    });
    expect(body).not.toHaveProperty('emptyReason');
    expect(body.results.map((result) => [result.rank, result.chunkId])).toEqual([
      [1, same],
      [2, diagonal],
      [3, orthogonal],
      [4, opposite],
    ]);
    const expectedDistances = [0, 1 - Math.SQRT1_2, 1, 2];
    body.results.forEach((result, index) => {
      expect(result.distance).toBeCloseTo(expectedDistances[index] ?? NaN, 6);
      expect(result.score).toBeCloseTo(1 - (expectedDistances[index] ?? NaN), 6);
      expect(result.score).toBe(1 - result.distance);
    });
    expect(body.results[0]).toMatchObject({
      documentId,
      filename: 'guide.md',
      chunkIndex: 2,
      headingPath: [],
      content: 'chunk 2',
      startOffset: 0,
      endOffset: 7,
    });
    expect(body.timings.embeddingMs).toBeGreaterThanOrEqual(0);
    expect(body.timings.searchMs).toBeGreaterThan(0);
  });

  it('only returns chunks of the requested collection, even if another one is closer', async () => {
    const own = await insertCollection('Own');
    const otherCollectionId = await insertCollection('Other');
    const other = await addDocument(otherCollectionId);
    // The other collection holds the perfect match …
    await addChunk(other, otherCollectionId, 0, unit(0));
    // … the requested one only an orthogonal chunk.
    const ownDocument = await addDocument(own);
    const ownChunk = await addChunk(ownDocument, own, 0, unit(1));

    const { body } = await search({ collectionId: own, query: 'query e0', topK: 5 });

    expect(body.results.map((result) => result.chunkId)).toEqual([ownChunk]);
    expect(body.results[0]?.distance).toBeCloseTo(1, 6);
  });

  it('ignores chunks without embedding and documents that are not ready', async () => {
    const collectionId = await insertCollection('Docs');
    const ready = await addDocument(collectionId);
    const expected = await addChunk(ready, collectionId, 0, unit(1));
    await addChunk(ready, collectionId, 1, null);
    for (const status of ['pending', 'processing', 'failed']) {
      const document = await addDocument(collectionId, status);
      await addChunk(document, collectionId, 0, unit(0));
    }

    const { body } = await search({ collectionId, query: 'query e0' });

    expect(body.results.map((result) => result.chunkId)).toEqual([expected]);
  });

  it('reports empty collections without calling the provider', async () => {
    const collectionId = await insertCollection('Empty');

    const { statusCode, body } = await search({ collectionId, query: 'query e0' });

    expect(statusCode).toBe(200);
    expect(body.results).toEqual([]);
    expect(body.emptyReason).toBe('collection_empty');
    expect(body.timings).toEqual({ embeddingMs: 0, searchMs: 0 });
    expect(provider.calls).toEqual([]);
  });

  it('reports collections without searchable chunks', async () => {
    const collectionId = await insertCollection('Unindexed');
    const failed = await addDocument(collectionId, 'failed');
    await addChunk(failed, collectionId, 0, unit(0));

    const { body } = await search({ collectionId, query: 'query e0' });
    expect(body).toMatchObject({ results: [], emptyReason: 'no_indexed_chunks' });

    // A ready document whose chunks lack vectors (e.g. chunked before 006) is not searchable.
    const ready = await addDocument(collectionId);
    await addChunk(ready, collectionId, 0, null);
    const second = await search({ collectionId, query: 'query e0' });
    expect(second.body).toMatchObject({ results: [], emptyReason: 'no_indexed_chunks' });
    expect(provider.calls).toHaveLength(1);
  });

  it('drops results below minScore and reports when none is left', async () => {
    const collectionId = await insertCollection('Docs');
    const documentId = await addDocument(collectionId);
    const same = await addChunk(documentId, collectionId, 0, unit(0));
    await addChunk(documentId, collectionId, 1, unit(1));

    const kept = await search({ collectionId, query: 'query e0', minScore: 0.5 });
    expect(kept.body.minScore).toBe(0.5);
    expect(kept.body.results.map((result) => [result.rank, result.chunkId])).toEqual([[1, same]]);

    // The fake provider's vector for an arbitrary text is nearly orthogonal to e0 and e1.
    const allBelow = await search({ collectionId, query: 'other query', minScore: 0.9 });
    expect(allBelow.statusCode).toBe(200);
    expect(allBelow.body).toMatchObject({ results: [], emptyReason: 'below_min_score' });
  });

  it('refuses collections embedded with another model (409)', async () => {
    const collectionId = await insertCollection('Old model', 'other-model');

    const response = await app.inject({
      method: 'POST',
      url: '/api/retrieval/search',
      payload: { collectionId, query: 'query e0' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: 'EMBEDDING_MODEL_MISMATCH',
        details: { collectionModel: 'other-model', providerModel: 'test-embedding-model' },
      },
    });
    expect(provider.calls).toEqual([]);
  });
});

describe('HNSW index with collection filter', () => {
  /**
   * A pool whose sessions make the planner prefer the HNSW index (sorting and sequential or
   * bitmap scans are disabled), so the test exercises the index even on small tables.
   */
  const indexPool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    options: '-c enable_seqscan=off -c enable_bitmapscan=off -c enable_sort=off',
  });
  const indexDb = drizzle(indexPool, { schema });
  const TOP_K = 10;
  let ownCollectionId: string;

  beforeEach(async () => {
    // Many chunks of a foreign collection are much closer to the query than any own chunk.
    const foreignCollectionId = await insertCollection('Foreign');
    const foreignDocument = await addDocument(foreignCollectionId);
    await addChunks(
      pool,
      foreignDocument,
      foreignCollectionId,
      Array.from({ length: 1500 }, (_, index) => plus(unit(0), unit(1 + (index % 700)), 0.05)),
    );
    ownCollectionId = await insertCollection('Own');
    const ownDocument = await addDocument(ownCollectionId);
    // Own chunk i: e0 + (0.5 + i/100)·e_(i+1) → strictly increasing distance with i.
    await addChunks(
      pool,
      ownDocument,
      ownCollectionId,
      Array.from({ length: 30 }, (_, index) => plus(unit(0), unit(index + 1), 0.5 + index / 100)),
    );
    await pool.query('ANALYZE chunks');
  });

  afterAll(async () => {
    await indexPool.end();
  });

  it('uses the HNSW index for the search statement', async () => {
    const plan = await indexDb.transaction(async (tx) => {
      await tx.execute(searchSettingsQuery(TOP_K));
      const result = await tx.execute<{ 'QUERY PLAN': string }>(
        sql`EXPLAIN ${searchQuery({ collectionId: ownCollectionId, embedding: unit(0), limit: TOP_K })}`,
      );
      return result.rows.map((row) => row['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('chunks_embedding_hnsw_idx');
  });

  it('without iterative scans the filter starves the result (control)', async () => {
    const rows = await indexDb.transaction(async (tx) => {
      const result = await tx.execute(
        searchQuery({ collectionId: ownCollectionId, embedding: unit(0), limit: TOP_K }),
      );
      return result.rows;
    });
    expect(rows.length).toBeLessThan(TOP_K);
  });

  it('returns topK own chunks with relaxed_order iterative scans, sorted by distance', async () => {
    const retrieval = createRetrievalService({
      repository: createRetrievalRepository(indexDb),
      embeddingProvider: provider,
      collections: services.collections,
      config: config.retrieval,
      columnDimensions: DIMENSIONS,
    });

    const response = await retrieval.search({
      collectionId: ownCollectionId,
      query: 'query e0',
      topK: TOP_K,
    });

    expect(response.results).toHaveLength(TOP_K);
    expect(response.results.map((result) => result.chunkIndex)).toEqual(
      Array.from({ length: TOP_K }, (_, index) => index),
    );
    expect(response.results.map((result) => result.rank)).toEqual(
      Array.from({ length: TOP_K }, (_, index) => index + 1),
    );
    response.results.forEach((result, index) => {
      const factor = 0.5 + index / 100;
      expect(result.distance).toBeCloseTo(1 - 1 / Math.sqrt(1 + factor * factor), 5);
    });
  });

  it('keeps SET LOCAL settings inside the search transaction', async () => {
    const show = async (name: string) =>
      (await indexPool.query<{ value: string }>('SELECT current_setting($1) AS value', [name]))
        .rows[0]?.value;
    const inside = await indexDb.transaction(async (tx) => {
      await tx.execute(searchSettingsQuery(TOP_K * 10));
      const iterative = await tx.execute<{ value: string }>(
        sql`SELECT current_setting('hnsw.iterative_scan') AS value`,
      );
      const efSearch = await tx.execute<{ value: string }>(
        sql`SELECT current_setting('hnsw.ef_search') AS value`,
      );
      return [iterative.rows[0]?.value, efSearch.rows[0]?.value];
    });
    expect(inside).toEqual(['relaxed_order', '100']);

    await createRetrievalRepository(indexDb).search({
      collectionId: ownCollectionId,
      embedding: unit(0),
      limit: TOP_K,
    });

    // Same (single) pooled connection, outside any transaction: back to pgvector's defaults.
    expect(await show('hnsw.iterative_scan')).toBe('off');
    expect(await show('hnsw.ef_search')).toBe('40');
  });
});
