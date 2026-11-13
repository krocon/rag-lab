import type {
  CollectionDto,
  DocumentChunksResponse,
  UploadDocumentsResponse,
} from '@raglab/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPgProbe } from '../../src/db/probe.js';
import { chunkText, type ChunkDraft } from '../../src/modules/chunking/chunker.js';
import { createChunkingStep } from '../../src/modules/chunking/chunking.step.js';
import { createChunksRepository } from '../../src/modules/chunking/chunks.repository.js';
import { createDocumentsRepository } from '../../src/modules/documents/documents.repository.js';
import {
  createDocumentIndexer,
  genericStepFailureMessage,
} from '../../src/modules/ingestion/document-indexer.js';
import { createServices, type AppServices } from '../../src/services.js';
import { createFakeEmbeddingProvider } from '../fakes/fake-embedding-provider.js';
import { silentLogger, testConfig } from '../helpers.js';
import { multipart } from '../multipart.js';
import {
  count,
  insertChunk,
  insertDocument,
  integrationDatabaseUrl,
  resetDatabase,
} from './setup.js';

const databaseUrl = integrationDatabaseUrl();
const connection = createDatabase(databaseUrl, 4);
const { pool } = connection;
const chunksRepository = createChunksRepository(connection.db);
const documentsRepository = createDocumentsRepository(connection.db);
const config = testConfig({ DATABASE_URL: databaseUrl, CHUNK_SIZE: '120', CHUNK_OVERLAP: '30' });
let app: FastifyInstance;
let services: AppServices;

beforeAll(async () => {
  await runMigrations(databaseUrl);
  // Default wiring as in main.ts (chunking, then embedding) with a fake embedding provider.
  services = createServices(connection.db, config, silentLogger, {
    embeddingProvider: createFakeEmbeddingProvider(),
  });
  app = await buildApp({
    config,
    probe: createPgProbe(pool, { embeddingDimensions: config.embedding.dimensions }),
    services,
    logger: false,
  });
});

beforeEach(async () => {
  await resetDatabase(pool);
});

afterAll(async () => {
  await app.close();
  await resetDatabase(pool);
  await connection.close();
});

async function createCollection(name: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/collections', payload: { name } });
  return response.json<CollectionDto>().id;
}

/** Uploads one file and waits until the indexer has processed it. */
async function uploadAndIndex(collectionId: string, filename: string, content: string) {
  const { payload, headers } = multipart([{ filename, content }]);
  const response = await app.inject({
    method: 'POST',
    url: `/api/collections/${collectionId}/documents`,
    payload,
    headers,
  });
  expect(response.statusCode).toBe(202);
  const id = response.json<UploadDocumentsResponse>().documents[0]?.id ?? '';
  // Joins the running job (or is a no-op once the document is `ready`).
  await services.ingestion.indexer?.index(id);
  return id;
}

interface ChunkRow {
  chunk_index: number;
  content: string;
  start_offset: number;
  end_offset: number;
  char_count: number;
  token_estimate: number;
  heading_path: string[];
  metadata: { overlapChars?: number; startLine?: number; endLine?: number; symbol?: string };
  has_embedding: boolean;
  collection_id: string;
}

async function chunkRows(documentId: string): Promise<ChunkRow[]> {
  const result = await pool.query<ChunkRow>(
    `SELECT chunk_index, content, start_offset, end_offset, char_count, token_estimate,
            heading_path, metadata, embedding IS NOT NULL AS has_embedding, collection_id
       FROM chunks WHERE document_id = $1 ORDER BY chunk_index`,
    [documentId],
  );
  return result.rows;
}

async function documentRow(id: string) {
  const result = await pool.query<{
    status: string;
    chunk_count: number;
    error_message: string | null;
    content: string;
  }>('SELECT status, chunk_count, error_message, content FROM documents WHERE id = $1', [id]);
  return result.rows[0];
}

const SAMPLE = [
  '# Guide',
  '',
  'RAGLab chunks documents deterministically. Every chunk keeps its offsets.',
  '',
  '## Install',
  '',
  '```bash',
  '# not a heading',
  'docker compose up -d postgres',
  '```',
  '',
  'Größe und Übermaß 😀 bleiben erhalten. A second sentence follows here! And a third one?',
].join('\r\n');

describe('chunking pipeline against PostgreSQL', () => {
  it('stores the chunks after upload, sets chunk_count and marks the document ready', async () => {
    const collectionId = await createCollection('Docs');

    const id = await uploadAndIndex(collectionId, 'guide.md', SAMPLE);

    const document = await documentRow(id);
    const rows = await chunkRows(id);
    expect(document).toMatchObject({ status: 'ready', error_message: null });
    expect(rows.length).toBeGreaterThan(1);
    expect(document?.chunk_count).toBe(rows.length);
    expect(await count(pool, 'chunks')).toBe(rows.length);

    const expected = chunkText(document?.content ?? '', {
      ...config.chunking,
      format: 'markdown',
    });
    expect(
      rows.map((row) => ({
        chunkIndex: row.chunk_index,
        content: row.content,
        startOffset: row.start_offset,
        endOffset: row.end_offset,
        charCount: row.char_count,
        tokenEstimate: row.token_estimate,
        headingPath: row.heading_path,
        overlapChars: row.metadata.overlapChars,
        startLine: row.metadata.startLine,
        endLine: row.metadata.endLine,
        symbol: row.metadata.symbol ?? null,
      })),
    ).toEqual(expected);
    for (const row of rows) {
      expect(row.content).toBe(document?.content.slice(row.start_offset, row.end_offset));
      expect(row.has_embedding).toBe(true);
      expect(row.collection_id).toBe(collectionId);
    }
    expect(rows.at(-1)?.heading_path).toEqual(['Guide', 'Install']);
  });

  it('chunks plain text without heading paths', async () => {
    const collectionId = await createCollection('Docs');

    const id = await uploadAndIndex(collectionId, 'notes.txt', '# not a heading\n\nplain text');

    expect((await chunkRows(id)).map((row) => row.heading_path)).toEqual([[]]);
  });

  it('serves the chunks via GET /api/documents/:id/chunks', async () => {
    const collectionId = await createCollection('Docs');
    const id = await uploadAndIndex(collectionId, 'guide.md', SAMPLE);

    const response = await app.inject({ method: 'GET', url: `/api/documents/${id}/chunks` });

    expect(response.statusCode).toBe(200);
    const body = response.json<DocumentChunksResponse>();
    const rows = await chunkRows(id);
    expect(body.documentId).toBe(id);
    expect(body.chunks.map((chunk) => [chunk.chunkIndex, chunk.content])).toEqual(
      rows.map((row) => [row.chunk_index, row.content]),
    );
    expect(body.chunks[0]).toMatchObject({
      documentId: id,
      collectionId,
      hasEmbedding: true,
      headingPath: ['Guide'],
      overlapChars: 0,
    });
    expect(body.chunks[0]).not.toHaveProperty('embedding');
  });

  it('replaces existing chunks when a failed document is processed again', async () => {
    const collectionId = await createCollection('Docs');
    const id = await insertDocument(pool, collectionId, { status: 'failed' });
    await insertChunk(pool, id, collectionId, 0, 'stale 0');
    await insertChunk(pool, id, collectionId, 7, 'stale 7');

    await services.ingestion.indexer?.index(id);

    const rows = await chunkRows(id);
    expect(rows.map((row) => row.content)).toEqual(['# Guide\nHello']);
    expect(await documentRow(id)).toMatchObject({ status: 'ready', chunk_count: 1 });
  });
});

describe('chunk transaction against PostgreSQL', () => {
  const valid = (index: number): ChunkDraft => ({
    chunkIndex: index,
    content: `chunk ${index}`,
    startOffset: index,
    endOffset: index + 1,
    charCount: 7,
    tokenEstimate: 2,
    headingPath: [],
    overlapChars: 0,
    startLine: 1,
    endLine: 1,
    symbol: null,
  });
  // Violates the CHECK constraint `chunks_content_not_blank`.
  const invalid = (index: number): ChunkDraft => ({ ...valid(index), content: '   ' });

  it('keeps the previous chunk set when writing the new one fails (no partial sets)', async () => {
    const collectionId = await createCollection('Docs');
    const id = await insertDocument(pool, collectionId, { status: 'processing' });
    await chunksRepository.replaceForDocument({ id, collectionId }, [valid(0), valid(1)]);

    // 600 drafts span two INSERT batches; the very last one fails.
    const drafts = [...Array.from({ length: 599 }, (_, i) => valid(i)), invalid(599)];
    await expect(
      chunksRepository.replaceForDocument({ id, collectionId }, drafts),
    ).rejects.toThrow();

    expect((await chunkRows(id)).map((row) => row.content)).toEqual(['chunk 0', 'chunk 1']);
  });

  it('marks the document failed with a readable message and stores no chunks', async () => {
    const collectionId = await createCollection('Docs');
    const id = await insertDocument(pool, collectionId, { status: 'pending' });
    const indexer = createDocumentIndexer({
      repository: documentsRepository,
      steps: [
        createChunkingStep({
          repository: chunksRepository,
          options: config.chunking,
          chunk: () => [valid(0), valid(1), invalid(2)],
        }),
      ],
      logger: silentLogger,
      concurrency: 1,
    });

    await indexer.index(id);

    expect(await documentRow(id)).toMatchObject({
      status: 'failed',
      chunk_count: 0,
      error_message: genericStepFailureMessage('chunking'),
    });
    expect(await count(pool, 'chunks')).toBe(0);
  });
});
