import type {
  ApiErrorResponse,
  DocumentContentResponse,
  UploadDocumentsResponse,
} from '@raglab/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { IndexingStep } from '../src/modules/ingestion/document-indexer.js';
import { sha256Hex } from '../src/modules/ingestion/hash.js';
import {
  createInMemoryServices,
  createInMemoryStore,
  createRecordingLogger,
  healthyProbe,
  type InMemoryStore,
  type RecordingLogger,
} from './fakes.js';
import { testConfig } from './helpers.js';
import { multipart, type MultipartFieldPart, type MultipartFilePart } from './multipart.js';

const UNKNOWN_ID = '0195f2a0-0000-7000-8000-000000000000';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup(
  options: { env?: NodeJS.ProcessEnv; steps?: IndexingStep[]; logger?: RecordingLogger } = {},
) {
  const config = testConfig({ MAX_UPLOAD_BYTES: '1024', MAX_UPLOAD_FILES: '3', ...options.env });
  const store: InMemoryStore = createInMemoryStore();
  const services = createInMemoryServices(config, store, {
    ...(options.steps ? { steps: options.steps } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  app = await buildApp({ config, probe: healthyProbe, services, logger: false });
  const collectionId = (await services.collections.create({ name: 'Docs' })).id;
  return { app, store, services, collectionId };
}

async function upload(
  target: FastifyInstance,
  collectionId: string,
  parts: (MultipartFilePart | MultipartFieldPart)[],
) {
  const { payload, headers } = multipart(parts);
  return target.inject({
    method: 'POST',
    url: `/api/collections/${collectionId}/documents`,
    payload,
    headers,
  });
}

function errorCode(response: { json: <T>() => T }) {
  return response.json<ApiErrorResponse>().error.code;
}

describe('POST /api/collections/:id/documents', () => {
  it('accepts Markdown and text files with 202 and stores normalised pending documents', async () => {
    const { app, store, collectionId } = await setup();
    const markdown = '\uFEFF# Guide\r\n\r\nHello Cafe\u0301\r\n';

    const response = await upload(app, collectionId, [
      { filename: 'guide.md', content: markdown, contentType: 'application/x-msdownload' },
      { filename: 'notes.TXT', content: 'plain\n' },
    ]);

    expect(response.statusCode).toBe(202);
    const { documents } = response.json<UploadDocumentsResponse>();
    expect(documents).toHaveLength(2);
    const normalised = '# Guide\n\nHello Café\n';
    expect(documents[0]).toMatchObject({
      collectionId,
      filename: 'guide.md',
      mimeType: 'text/markdown',
      sizeBytes: Buffer.byteLength(markdown),
      contentSha256: sha256Hex(normalised),
      status: 'pending',
      errorMessage: null,
      chunkCount: 0,
      metadata: { title: 'Guide' },
    });
    expect(documents[1]).toMatchObject({
      filename: 'notes.TXT',
      mimeType: 'text/plain',
      metadata: {},
    });
    expect(response.body).not.toContain('Hello');
    expect(store.documents.get(documents[0]?.id ?? '')?.content).toBe(normalised);
  });

  it('keeps documents pending while no indexing step exists', async () => {
    const { app, store, collectionId } = await setup();

    await upload(app, collectionId, [{ filename: 'a.md', content: '# A' }]);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect([...store.documents.values()].map((document) => document.status)).toEqual(['pending']);
  });

  it('starts the indexer asynchronously when steps exist', async () => {
    const step: IndexingStep = {
      name: 'fake-chunking',
      run: async (context) => {
        context.chunkCount = 2;
      },
    };
    const { app, store, collectionId } = await setup({ steps: [step] });

    const response = await upload(app, collectionId, [{ filename: 'a.md', content: '# A' }]);
    expect(response.json<UploadDocumentsResponse>().documents[0]?.status).toBe('pending');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect([...store.documents.values()][0]).toMatchObject({ status: 'ready', chunkCount: 2 });
  });

  it('sanitises the filename', async () => {
    const { app, collectionId } = await setup();

    const response = await upload(app, collectionId, [
      { filename: '../../secret/\u202Enotes.md', content: 'x' },
    ]);

    expect(response.json<UploadDocumentsResponse>().documents[0]?.filename).toBe('notes.md');
  });

  it.each(['paper.pdf', 'setup.exe', 'notes.md.exe', 'README'])(
    'rejects %s with 415 UNSUPPORTED_FILE_TYPE',
    async (filename) => {
      const { app, store, collectionId } = await setup();

      const response = await upload(app, collectionId, [{ filename, content: 'text' }]);

      expect(response.statusCode).toBe(415);
      expect(errorCode(response)).toBe('UNSUPPORTED_FILE_TYPE');
      expect(store.documents.size).toBe(0);
    },
  );

  it('rejects invalid UTF-8 and NUL bytes with 400 INVALID_ENCODING', async () => {
    const { app, collectionId } = await setup();

    const latin1 = await upload(app, collectionId, [
      { filename: 'a.txt', content: Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x65]) },
    ]);
    const binary = await upload(app, collectionId, [
      { filename: 'b.md', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]) },
    ]);

    expect(latin1.statusCode).toBe(400);
    expect(errorCode(latin1)).toBe('INVALID_ENCODING');
    expect(binary.statusCode).toBe(400);
    expect(errorCode(binary)).toBe('INVALID_ENCODING');
  });

  it('rejects empty and whitespace-only files with 400 EMPTY_DOCUMENT', async () => {
    const { app, collectionId } = await setup();

    const empty = await upload(app, collectionId, [{ filename: 'a.md', content: '' }]);
    const blank = await upload(app, collectionId, [
      { filename: 'b.txt', content: '\uFEFF \r\n\t\n\u0007' },
    ]);

    expect(empty.statusCode).toBe(400);
    expect(errorCode(empty)).toBe('EMPTY_DOCUMENT');
    expect(errorCode(blank)).toBe('EMPTY_DOCUMENT');
  });

  it('rejects files above MAX_UPLOAD_BYTES with 413 FILE_TOO_LARGE', async () => {
    const { app, store, collectionId } = await setup();

    const response = await upload(app, collectionId, [
      { filename: 'big.md', content: 'x'.repeat(1025) },
    ]);

    expect(response.statusCode).toBe(413);
    expect(response.json<ApiErrorResponse>().error).toMatchObject({
      code: 'FILE_TOO_LARGE',
      details: { filename: 'big.md', maxFileBytes: 1024 },
    });
    expect(store.documents.size).toBe(0);
  });

  it('accepts a file of exactly MAX_UPLOAD_BYTES', async () => {
    const { app, collectionId } = await setup();

    const response = await upload(app, collectionId, [
      { filename: 'edge.md', content: 'x'.repeat(1024) },
    ]);

    expect(response.statusCode).toBe(202);
  });

  it('allows files larger than the global JSON body limit (1 MiB)', async () => {
    const { app, collectionId } = await setup({
      env: { MAX_UPLOAD_BYTES: String(3 * 1024 * 1024) },
    });

    const response = await upload(app, collectionId, [
      { filename: 'large.txt', content: 'lorem ipsum\n'.repeat(200_000) },
    ]);

    expect(response.statusCode).toBe(202);
  });

  it('rejects more than MAX_UPLOAD_FILES files with 413 TOO_MANY_FILES', async () => {
    const { app, store, collectionId } = await setup();

    const response = await upload(
      app,
      collectionId,
      [1, 2, 3, 4].map((n) => ({ filename: `f${n}.md`, content: `# ${n}` })),
    );

    expect(response.statusCode).toBe(413);
    expect(errorCode(response)).toBe('TOO_MANY_FILES');
    expect(store.documents.size).toBe(0);
  });

  it('rejects a request without files with 400 NO_FILE', async () => {
    const { app, collectionId } = await setup();

    const noParts = await upload(app, collectionId, []);
    const onlyFields = await upload(app, collectionId, [{ field: 'note', value: 'hello' }]);

    expect(noParts.statusCode).toBe(400);
    expect(errorCode(noParts)).toBe('NO_FILE');
    expect(errorCode(onlyFields)).toBe('NO_FILE');
  });

  it('rejects non-multipart requests with 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const { app, collectionId } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: `/api/collections/${collectionId}/documents`,
      payload: { content: 'x' },
    });

    expect(response.statusCode).toBe(415);
    expect(errorCode(response)).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects a malformed multipart body with 400 MALFORMED_MULTIPART', async () => {
    const { app, collectionId } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: `/api/collections/${collectionId}/documents`,
      payload: '--x\r\nContent-Disposition: form-data; name="file"; filename="a.md"\r\n\r\nabc',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
    });

    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('MALFORMED_MULTIPART');
  });

  it('returns 404 COLLECTION_NOT_FOUND for an unknown collection', async () => {
    const { app } = await setup();

    const response = await upload(app, UNKNOWN_ID, [{ filename: 'a.md', content: '# A' }]);

    expect(response.statusCode).toBe(404);
    expect(errorCode(response)).toBe('COLLECTION_NOT_FOUND');
  });

  it('returns 400 VALIDATION_ERROR for a malformed collection id', async () => {
    const { app } = await setup();

    const response = await upload(app, 'abc', [{ filename: 'a.md', content: '# A' }]);

    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('VALIDATION_ERROR');
  });

  it('detects duplicates per collection, including CRLF vs LF variants', async () => {
    const { app, services, collectionId } = await setup();
    const first = await upload(app, collectionId, [{ filename: 'lf.md', content: '# A\nb\n' }]);
    const existingId = first.json<UploadDocumentsResponse>().documents[0]?.id;

    const duplicate = await upload(app, collectionId, [
      { filename: 'crlf.md', content: '# A\r\nb\r\n' },
    ]);

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json<ApiErrorResponse>().error).toMatchObject({
      code: 'DUPLICATE_DOCUMENT',
      details: { filename: 'crlf.md', existingDocumentId: existingId },
    });

    const other = (await services.collections.create({ name: 'Other' })).id;
    const elsewhere = await upload(app, other, [{ filename: 'crlf.md', content: '# A\r\nb\r\n' }]);
    expect(elsewhere.statusCode).toBe(202);
  });

  it('rejects duplicates within one request', async () => {
    const { app, store, collectionId } = await setup();

    const response = await upload(app, collectionId, [
      { filename: 'a.md', content: 'same\n' },
      { filename: 'b.txt', content: 'same\r\n' },
    ]);

    expect(response.statusCode).toBe(409);
    expect(response.json<ApiErrorResponse>().error.details).toEqual({
      filename: 'b.txt',
      duplicateOfFilename: 'a.md',
    });
    expect(store.documents.size).toBe(0);
  });

  it('is all or nothing: one invalid file rejects the whole request', async () => {
    const { app, store, collectionId } = await setup();

    const response = await upload(app, collectionId, [
      { filename: 'good.md', content: '# Good' },
      { filename: 'bad.pdf', content: '%PDF' },
    ]);

    expect(response.statusCode).toBe(415);
    expect(store.documents.size).toBe(0);
  });

  it('does not log document content', async () => {
    const logger = createRecordingLogger();
    const step: IndexingStep = {
      name: 'failing',
      run: async () => {
        throw new Error('step failed');
      },
    };
    const { app, store, collectionId } = await setup({ steps: [step], logger });

    await upload(app, collectionId, [{ filename: 'a.md', content: 'CONFIDENTIAL BODY' }]);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect([...store.documents.values()][0]?.status).toBe('failed');
    expect(logger.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(logger.entries)).not.toContain('CONFIDENTIAL');
  });
});

describe('GET /api/documents/:id/content', () => {
  it('returns the normalised text', async () => {
    const { app, collectionId } = await setup();
    const uploaded = await upload(app, collectionId, [
      { filename: 'a.md', content: '# A\r\n\r\n\r\n\r\n\r\nb' },
    ]);
    const id = uploaded.json<UploadDocumentsResponse>().documents[0]?.id ?? '';

    const response = await app.inject({ method: 'GET', url: `/api/documents/${id}/content` });

    expect(response.statusCode).toBe(200);
    expect(response.json<DocumentContentResponse>()).toEqual({
      documentId: id,
      content: '# A\n\n\nb',
    });
  });

  it('returns 404 DOCUMENT_NOT_FOUND for unknown documents', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'GET',
      url: `/api/documents/${UNKNOWN_ID}/content`,
    });

    expect(response.statusCode).toBe(404);
    expect(errorCode(response)).toBe('DOCUMENT_NOT_FOUND');
  });
});

describe('OpenAPI', () => {
  it('documents the upload as multipart/form-data', async () => {
    const { app } = await setup();

    const spec = (await app.inject({ method: 'GET', url: '/api/docs/json' })).json<{
      paths: Record<string, Record<string, { requestBody?: { content: Record<string, unknown> } }>>;
    }>();

    const post = spec.paths['/api/collections/{id}/documents']?.['post'];
    expect(Object.keys(post?.requestBody?.content ?? {})).toEqual(['multipart/form-data']);
    expect(spec.paths['/api/documents/{id}/content']).toBeDefined();
  });
});
