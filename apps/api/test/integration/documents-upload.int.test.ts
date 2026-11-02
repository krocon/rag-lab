import type {
  ApiErrorResponse,
  CollectionDto,
  DocumentContentResponse,
  UploadDocumentsResponse,
} from '@raglab/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPgProbe } from '../../src/db/probe.js';
import { createDocumentsRepository } from '../../src/modules/documents/documents.repository.js';
import {
  createDocumentIndexer,
  genericStepFailureMessage,
} from '../../src/modules/ingestion/document-indexer.js';
import { sha256Hex } from '../../src/modules/ingestion/hash.js';
import { INTERRUPTED_MESSAGE, recoverDocuments } from '../../src/modules/ingestion/recovery.js';
import { createServices } from '../../src/services.js';
import { silentLogger, testConfig } from '../helpers.js';
import { multipart, type MultipartFilePart } from '../multipart.js';
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
const repository = createDocumentsRepository(connection.db);
let app: FastifyInstance;

beforeAll(async () => {
  await runMigrations(databaseUrl);
  const config = testConfig({ DATABASE_URL: databaseUrl });
  app = await buildApp({
    config,
    probe: createPgProbe(pool, { embeddingDimensions: config.embedding.dimensions }),
    // No indexing steps: these tests check the upload itself (documents stay `pending`).
    // The full pipeline is covered by chunking.int.test.ts.
    services: createServices(connection.db, config, silentLogger, { steps: [] }),
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

function upload(collectionId: string, files: MultipartFilePart[]) {
  const { payload, headers } = multipart(files);
  return app.inject({
    method: 'POST',
    url: `/api/collections/${collectionId}/documents`,
    payload,
    headers,
  });
}

interface DocumentRow {
  filename: string;
  mime_type: string;
  size_bytes: number;
  content_sha256: string;
  content: string;
  status: string;
  error_message: string | null;
  chunk_count: number;
  metadata: Record<string, unknown>;
}

async function documentRow(id: string): Promise<DocumentRow | undefined> {
  const result = await pool.query<DocumentRow>('SELECT * FROM documents WHERE id = $1', [id]);
  return result.rows[0];
}

describe('document upload against PostgreSQL', () => {
  it('stores normalised content, hash, size and MIME type as a pending document', async () => {
    const collectionId = await createCollection('Docs');
    const raw = '﻿# Guide\r\n\r\n\r\n\r\nCafé\u0007\r\n';

    const response = await upload(collectionId, [{ filename: 'guide.md', content: raw }]);

    expect(response.statusCode).toBe(202);
    const [document] = response.json<UploadDocumentsResponse>().documents;
    const normalised = '# Guide\n\n\nCafé\n';
    expect(await documentRow(document?.id ?? '')).toMatchObject({
      filename: 'guide.md',
      mime_type: 'text/markdown',
      size_bytes: Buffer.byteLength(raw),
      content_sha256: sha256Hex(normalised),
      content: normalised,
      status: 'pending',
      error_message: null,
      chunk_count: 0,
      metadata: { title: 'Guide' },
    });

    const content = await app.inject({
      method: 'GET',
      url: `/api/documents/${document?.id}/content`,
    });
    expect(content.json<DocumentContentResponse>().content).toBe(normalised);
  });

  it('stores several files in one request', async () => {
    const collectionId = await createCollection('Docs');

    const response = await upload(collectionId, [
      { filename: 'a.md', content: '# A' },
      { filename: 'b.txt', content: 'B' },
    ]);

    expect(response.statusCode).toBe(202);
    expect(response.json<UploadDocumentsResponse>().documents.map((d) => d.filename)).toEqual([
      'a.md',
      'b.txt',
    ]);
    expect(await count(pool, 'documents')).toBe(2);
  });

  it('rejects the same content in the same collection (CRLF = LF) but allows it elsewhere', async () => {
    const docs = await createCollection('Docs');
    const other = await createCollection('Other');
    const first = await upload(docs, [{ filename: 'lf.txt', content: 'line 1\nline 2\n' }]);

    const duplicate = await upload(docs, [
      { filename: 'crlf.txt', content: 'line 1\r\nline 2\r\n' },
    ]);
    const elsewhere = await upload(other, [
      { filename: 'crlf.txt', content: 'line 1\r\nline 2\r\n' },
    ]);

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json<ApiErrorResponse>().error).toMatchObject({
      code: 'DUPLICATE_DOCUMENT',
      details: {
        existingDocumentId: first.json<UploadDocumentsResponse>().documents[0]?.id,
        existingDocumentStatus: 'pending',
      },
    });
    expect(elsewhere.statusCode).toBe(202);
    expect(await count(pool, 'documents')).toBe(2);
  });

  it('maps a concurrent duplicate upload (unique index race) to 409', async () => {
    const collectionId = await createCollection('Docs');

    const responses = await Promise.all(
      [1, 2, 3].map((n) => upload(collectionId, [{ filename: `${n}.md`, content: '# Same' }])),
    );

    expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 409, 409]);
    expect(await count(pool, 'documents')).toBe(1);
  });

  it('stores nothing when one file of the request is invalid', async () => {
    const collectionId = await createCollection('Docs');

    const response = await upload(collectionId, [
      { filename: 'good.md', content: '# Good' },
      { filename: 'bad.md', content: Buffer.from([0xff, 0xfe]) },
    ]);

    expect(response.statusCode).toBe(400);
    expect(await count(pool, 'documents')).toBe(0);
  });

  it('returns 404 for an unknown collection', async () => {
    const response = await upload('0195f2a0-0000-7000-8000-000000000000', [
      { filename: 'a.md', content: '# A' },
    ]);

    expect(response.statusCode).toBe(404);
    expect(response.json<ApiErrorResponse>().error.code).toBe('COLLECTION_NOT_FOUND');
  });

  it('cascades: deleting the document or the collection removes uploads and chunks', async () => {
    const collectionId = await createCollection('Docs');
    const uploaded = await upload(collectionId, [
      { filename: 'a.md', content: '# A' },
      { filename: 'b.md', content: '# B' },
    ]);
    const [a, b] = uploaded.json<UploadDocumentsResponse>().documents;
    await insertChunk(pool, a?.id ?? '', collectionId, 0, '# A');
    await insertChunk(pool, b?.id ?? '', collectionId, 0, '# B');

    await app.inject({ method: 'DELETE', url: `/api/documents/${a?.id}` });
    expect(await count(pool, 'documents')).toBe(1);
    expect(await count(pool, 'chunks')).toBe(1);

    await app.inject({ method: 'DELETE', url: `/api/collections/${collectionId}` });
    expect(await count(pool, 'documents')).toBe(0);
    expect(await count(pool, 'chunks')).toBe(0);
  });
});

describe('indexer status transitions against PostgreSQL', () => {
  it('moves pending → processing → ready with the chunk count', async () => {
    const collectionId = await createCollection('Docs');
    const id = await insertDocument(pool, collectionId, { status: 'pending' });
    const seen: string[] = [];
    const indexer = createDocumentIndexer({
      repository,
      steps: [
        {
          name: 'fake-chunking',
          run: async (context) => {
            seen.push((await documentRow(context.document.id))?.status ?? '');
            expect(context.document.content).toBe('# Guide\nHello');
            context.chunkCount = 3;
          },
        },
      ],
      logger: silentLogger,
      concurrency: 1,
    });

    await indexer.index(id);

    expect(seen).toEqual(['processing']);
    expect(await documentRow(id)).toMatchObject({ status: 'ready', chunk_count: 3 });
  });

  it('moves processing → failed with a readable message', async () => {
    const collectionId = await createCollection('Docs');
    const id = await insertDocument(pool, collectionId, { status: 'pending' });
    const indexer = createDocumentIndexer({
      repository,
      steps: [
        {
          name: 'fake-embedding',
          run: async () => {
            throw new Error('boom');
          },
        },
      ],
      logger: silentLogger,
      concurrency: 1,
    });

    await indexer.index(id);

    expect(await documentRow(id)).toMatchObject({
      status: 'failed',
      error_message: genericStepFailureMessage('fake-embedding'),
    });
  });
});

describe('startup recovery against PostgreSQL', () => {
  it('leaves no document in processing', async () => {
    const collectionId = await createCollection('Docs');
    const processing = await insertDocument(pool, collectionId, {
      status: 'processing',
      contentSha256: '1'.repeat(64),
    });
    const ready = await insertDocument(pool, collectionId, { contentSha256: '2'.repeat(64) });

    const result = await recoverDocuments({ repository, indexer: undefined, logger: silentLogger });

    expect(result).toEqual({ failed: 1, resumed: 0 });
    expect(await documentRow(processing)).toMatchObject({
      status: 'failed',
      error_message: INTERRUPTED_MESSAGE,
    });
    expect((await documentRow(ready))?.status).toBe('ready');
    const stuck = await pool.query("SELECT 1 FROM documents WHERE status = 'processing'");
    expect(stuck.rowCount).toBe(0);
  });
});
