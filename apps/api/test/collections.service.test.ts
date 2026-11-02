import { describe, expect, it } from 'vitest';
import { AppError } from '../src/http/errors.js';
import type { CollectionsRepository } from '../src/modules/collections/collections.repository.js';
import { createCollectionsService } from '../src/modules/collections/collections.service.js';
import { createInMemoryCollectionsRepository, createInMemoryStore } from './fakes.js';
import { testConfig } from './helpers.js';

function setup(overrides: NodeJS.ProcessEnv = {}) {
  const config = testConfig(overrides);
  const repository = createInMemoryCollectionsRepository(createInMemoryStore());
  return { service: createCollectionsService({ repository, embedding: config.embedding }) };
}

async function expectAppError(promise: Promise<unknown>, statusCode: number, code: string) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ statusCode, code });
}

describe('collections service', () => {
  it('copies embedding provider, model and dimensions from the configuration', async () => {
    const { service } = setup({
      EMBEDDING_MODEL: 'mxbai-embed-large',
      EMBEDDING_DIMENSIONS: '1024',
    });

    const created = await service.create({ name: 'Docs' });

    expect(created).toMatchObject({
      name: 'Docs',
      description: null,
      embeddingProvider: 'ollama',
      embeddingModel: 'mxbai-embed-large',
      embeddingDimensions: 1024,
      documentCount: 0,
      readyDocumentCount: 0,
      chunkCount: 0,
    });
    expect(Date.parse(created.createdAt)).not.toBeNaN();
  });

  it('ignores embedding fields smuggled into the input', async () => {
    const { service } = setup();

    const created = await service.create({
      name: 'Docs',
      ...({ embeddingModel: 'evil', embeddingDimensions: 3 } as object),
    });

    expect(created).toMatchObject({
      embeddingModel: 'test-embedding-model',
      embeddingDimensions: 768,
    });
  });

  it('trims name and description; a blank description becomes null', async () => {
    const { service } = setup();

    const created = await service.create({ name: '  Docs  ', description: '   ' });

    expect(created.name).toBe('Docs');
    expect(created.description).toBeNull();
  });

  it('rejects a blank name', async () => {
    const { service } = setup();

    await expectAppError(service.create({ name: '   ' }), 400, 'VALIDATION_ERROR');
  });

  it('maps the case-insensitive name conflict to 409 COLLECTION_NAME_TAKEN', async () => {
    const { service } = setup();
    await service.create({ name: 'Docs' });

    await expectAppError(service.create({ name: 'docs' }), 409, 'COLLECTION_NAME_TAKEN');
  });

  it('maps a rename onto an existing name to 409', async () => {
    const { service } = setup();
    await service.create({ name: 'Docs' });
    const other = await service.create({ name: 'Other' });

    await expectAppError(service.update(other.id, { name: 'DOCS' }), 409, 'COLLECTION_NAME_TAKEN');
  });

  it('updates name and clears the description with null', async () => {
    const { service } = setup();
    const created = await service.create({ name: 'Docs', description: 'About docs' });

    const updated = await service.update(created.id, { name: 'Handbook', description: null });

    expect(updated).toMatchObject({ id: created.id, name: 'Handbook', description: null });
    expect(updated.embeddingModel).toBe(created.embeddingModel);
  });

  it('rejects an update without changes', async () => {
    const { service } = setup();
    const created = await service.create({ name: 'Docs' });

    await expectAppError(service.update(created.id, {}), 400, 'VALIDATION_ERROR');
  });

  it('reports unknown ids as 404 COLLECTION_NOT_FOUND', async () => {
    const { service } = setup();
    const id = '0195f2a0-0000-7000-8000-000000000000';

    await expectAppError(service.get(id), 404, 'COLLECTION_NOT_FOUND');
    await expectAppError(service.update(id, { name: 'x' }), 404, 'COLLECTION_NOT_FOUND');
    await expectAppError(service.delete(id), 404, 'COLLECTION_NOT_FOUND');
    await expectAppError(service.assertExists(id), 404, 'COLLECTION_NOT_FOUND');
    await expectAppError(service.getIndexStats(id), 404, 'COLLECTION_NOT_FOUND');
  });

  it('reports index stats of an empty collection as zeros', async () => {
    const { service } = setup();
    const created = await service.create({ name: 'Docs' });

    expect(await service.getIndexStats(created.id)).toEqual({
      documentCount: 0,
      documentsByStatus: { pending: 0, processing: 0, ready: 0, failed: 0 },
      chunkCount: 0,
      searchableChunkCount: 0,
      chunksWithoutEmbedding: 0,
    });
  });

  it('rethrows repository errors that are not name conflicts', async () => {
    const failure = new Error('connection lost');
    const repository = {
      insert: async () => {
        throw failure;
      },
    } as unknown as CollectionsRepository;
    const service = createCollectionsService({ repository, embedding: testConfig().embedding });

    await expect(service.create({ name: 'Docs' })).rejects.toBe(failure);
  });
});
