import type {
  ApiErrorResponse,
  ChunkPreviewResponse,
  DocumentChunksResponse,
  UploadDocumentsResponse,
} from '@raglab/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { MAX_PREVIEW_TEXT_LENGTH } from '../../src/modules/chunking/chunking.routes.js';
import { createChunkingStep } from '../../src/modules/chunking/chunking.step.js';
import {
  createInMemoryChunksRepository,
  createInMemoryServices,
  createInMemoryStore,
  fakeDocument,
  healthyProbe,
} from '../fakes.js';
import { testConfig } from '../helpers.js';
import { multipart } from '../multipart.js';

const UNKNOWN_ID = '0195f2a0-0000-7000-8000-000000000000';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup(env: NodeJS.ProcessEnv = {}) {
  const config = testConfig({ CHUNK_SIZE: '40', CHUNK_OVERLAP: '10', ...env });
  const store = createInMemoryStore();
  const steps = [
    createChunkingStep({
      repository: createInMemoryChunksRepository(store),
      options: config.chunking,
    }),
  ];
  const services = createInMemoryServices(config, store, { steps });
  app = await buildApp({ config, probe: healthyProbe, services, logger: false });
  const collectionId = (await services.collections.create({ name: 'Docs' })).id;
  return { app, store, services, collectionId };
}

describe('GET /api/documents/:id/chunks', () => {
  it('returns the chunks of an uploaded document after indexing, ordered by chunkIndex', async () => {
    const { app, services, collectionId } = await setup();
    const text = '# Guide\n\nFirst paragraph here.\n\nSecond paragraph, a bit longer than that.';
    const { payload, headers } = multipart([{ filename: 'guide.md', content: text }]);
    const uploaded = await app.inject({
      method: 'POST',
      url: `/api/collections/${collectionId}/documents`,
      payload,
      headers,
    });
    const id = uploaded.json<UploadDocumentsResponse>().documents[0]?.id ?? '';
    await services.ingestion.indexer?.index(id);

    const response = await app.inject({ method: 'GET', url: `/api/documents/${id}/chunks` });

    expect(response.statusCode).toBe(200);
    const body = response.json<DocumentChunksResponse>();
    expect(body.documentId).toBe(id);
    expect(body.chunks.length).toBeGreaterThan(1);
    expect(body.chunks.map((chunk) => chunk.chunkIndex)).toEqual(body.chunks.map((_, i) => i));
    for (const chunk of body.chunks) {
      expect(chunk.content).toBe(text.slice(chunk.startOffset, chunk.endOffset));
      expect(chunk).toMatchObject({
        documentId: id,
        collectionId,
        headingPath: ['Guide'],
        hasEmbedding: false,
      });
      expect(chunk).not.toHaveProperty('embedding');
    }
    const document = await services.documents.get(id);
    expect(document).toMatchObject({ status: 'ready', chunkCount: body.chunks.length });
  });

  it('returns an empty list for a document that is not chunked yet', async () => {
    const { app, store, collectionId } = await setup();
    const document = fakeDocument({ collectionId, status: 'pending', chunkCount: 0 });
    store.documents.set(document.id, document);

    const response = await app.inject({
      method: 'GET',
      url: `/api/documents/${document.id}/chunks`,
    });

    expect(response.json<DocumentChunksResponse>()).toEqual({
      documentId: document.id,
      chunks: [],
    });
  });

  it('returns 404 for an unknown document and 400 for a malformed id', async () => {
    const { app } = await setup();

    const unknown = await app.inject({ method: 'GET', url: `/api/documents/${UNKNOWN_ID}/chunks` });
    const malformed = await app.inject({ method: 'GET', url: '/api/documents/nope/chunks' });

    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<ApiErrorResponse>().error.code).toBe('DOCUMENT_NOT_FOUND');
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<ApiErrorResponse>().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/chunking/preview', () => {
  const preview = (target: FastifyInstance, payload: unknown) =>
    target.inject({ method: 'POST', url: '/api/chunking/preview', payload: payload as object });

  it('chunks the normalised text with the configured defaults', async () => {
    const { app } = await setup();

    const response = await preview(app, {
      text: '﻿# A\r\n\r\nalpha beta gamma delta epsilon zeta eta theta iota',
      format: 'markdown',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<ChunkPreviewResponse>();
    expect(body.options).toEqual({ targetSize: 40, overlap: 10, format: 'markdown' });
    expect(body.normalizedText).toBe('# A\n\nalpha beta gamma delta epsilon zeta eta theta iota');
    expect(body.chunks.length).toBeGreaterThan(1);
    for (const chunk of body.chunks) {
      expect(chunk.content).toBe(body.normalizedText.slice(chunk.startOffset, chunk.endOffset));
      expect(chunk.charCount).toBeLessThanOrEqual(40);
    }
  });

  it('accepts explicit options', async () => {
    const { app } = await setup();

    const response = await preview(app, {
      text: 'one two three',
      format: 'text',
      targetSize: 7,
      overlap: 0,
    });

    expect(response.json<ChunkPreviewResponse>().chunks.map((chunk) => chunk.content)).toEqual([
      'one two',
      'three',
    ]);
  });

  it('rejects overlap >= targetSize with 400 INVALID_CHUNKING_OPTIONS', async () => {
    const { app } = await setup();

    const response = await preview(app, { text: 'x', format: 'text', targetSize: 10 });

    expect(response.statusCode).toBe(400);
    expect(response.json<ApiErrorResponse>().error).toMatchObject({
      code: 'INVALID_CHUNKING_OPTIONS',
      details: { targetSize: 10, overlap: 10 },
    });
  });

  it.each([
    ['missing format', { text: 'x' }],
    ['unknown format', { text: 'x', format: 'pdf' }],
    ['unknown property', { text: 'x', format: 'text', extra: true }],
    ['targetSize 0', { text: 'x', format: 'text', targetSize: 0 }],
    ['negative overlap', { text: 'x', format: 'text', overlap: -1 }],
    ['text too long', { text: 'x'.repeat(MAX_PREVIEW_TEXT_LENGTH + 1), format: 'text' }],
  ])('rejects %s with 400 VALIDATION_ERROR', async (_name, payload) => {
    const { app } = await setup();

    const response = await preview(app, payload);

    expect(response.statusCode).toBe(400);
    expect(response.json<ApiErrorResponse>().error.code).toBe('VALIDATION_ERROR');
  });
});
