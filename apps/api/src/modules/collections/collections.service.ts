import type {
  CollectionDto,
  CreateCollectionRequest,
  UpdateCollectionRequest,
} from '@raglab/shared';
import { badRequest, conflict, isUniqueViolation, notFound } from '../../http/errors.js';
import {
  COLLECTION_NAME_UNIQUE_INDEX,
  type CollectionIndexStats,
  type CollectionPatch,
  type CollectionsRepository,
  type CollectionWithStats,
} from './collections.repository.js';

export interface CollectionsService {
  list(): Promise<CollectionDto[]>;
  get(id: string): Promise<CollectionDto>;
  /** Throws `404 COLLECTION_NOT_FOUND` unless the collection exists (used by other modules). */
  assertExists(id: string): Promise<void>;
  create(input: CreateCollectionRequest): Promise<CollectionDto>;
  update(id: string, input: UpdateCollectionRequest): Promise<CollectionDto>;
  delete(id: string): Promise<void>;
  /**
   * Documents by status and chunks by embedding state (retrieval diagnostics).
   * Throws `404 COLLECTION_NOT_FOUND` for unknown collections.
   */
  getIndexStats(id: string): Promise<CollectionIndexStats>;
}

/** Provider, model and dimension stored with every new collection. */
export interface CollectionEmbeddingSettings {
  provider: string;
  model: string;
  dimensions: number;
}

export interface CollectionsServiceDependencies {
  repository: CollectionsRepository;
  /** The embedding settings in effect; copied into every new collection. */
  embedding: CollectionEmbeddingSettings;
}

export function createCollectionsService({
  repository,
  embedding,
}: CollectionsServiceDependencies): CollectionsService {
  const collectionNotFound = (id: string) =>
    notFound('COLLECTION_NOT_FOUND', `Collection ${id} does not exist`);

  const nameTaken = (name: string) =>
    conflict('COLLECTION_NAME_TAKEN', `A collection named "${name}" already exists`, { name });

  /** Runs a write and maps the case-insensitive name index violation to 409. */
  async function guardName<T>(name: string | undefined, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (name !== undefined && isUniqueViolation(error, COLLECTION_NAME_UNIQUE_INDEX)) {
        throw nameTaken(name);
      }
      throw error;
    }
  }

  return {
    async list() {
      return (await repository.list()).map(toCollectionDto);
    },

    async get(id) {
      const collection = await repository.findById(id);
      if (!collection) {
        throw collectionNotFound(id);
      }
      return toCollectionDto(collection);
    },

    async getIndexStats(id) {
      const [exists, stats] = await Promise.all([repository.exists(id), repository.indexStats(id)]);
      if (!exists) {
        throw collectionNotFound(id);
      }
      return stats;
    },

    async assertExists(id) {
      if (!(await repository.exists(id))) {
        throw collectionNotFound(id);
      }
    },

    async create(input) {
      const name = normalizeName(input.name);
      const created = await guardName(name, () =>
        repository.insert({
          name,
          description: normalizeDescription(input.description),
          // Taken from the configuration, never from the client (see docs/data-model.md).
          embeddingProvider: embedding.provider,
          embeddingModel: embedding.model,
          embeddingDimensions: embedding.dimensions,
        }),
      );
      return toCollectionDto(created);
    },

    async update(id, input) {
      const patch: CollectionPatch = {};
      if (input.name !== undefined) {
        patch.name = normalizeName(input.name);
      }
      if (input.description !== undefined) {
        patch.description = normalizeDescription(input.description);
      }
      if (patch.name === undefined && patch.description === undefined) {
        throw badRequest('VALIDATION_ERROR', 'Nothing to update: provide name and/or description');
      }
      const updated = await guardName(patch.name, () => repository.update(id, patch));
      if (!updated) {
        throw collectionNotFound(id);
      }
      return toCollectionDto(updated);
    },

    async delete(id) {
      if (!(await repository.delete(id))) {
        throw collectionNotFound(id);
      }
    },
  };
}

function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw badRequest('VALIDATION_ERROR', 'Collection name must not be blank');
  }
  return trimmed;
}

/** Trims the description; blank or `null` clears it. */
function normalizeDescription(description: string | null | undefined): string | null {
  const trimmed = description?.trim();
  return trimmed ? trimmed : null;
}

export function toCollectionDto(collection: CollectionWithStats): CollectionDto {
  return {
    id: collection.id,
    name: collection.name,
    description: collection.description,
    embeddingProvider: collection.embeddingProvider,
    embeddingModel: collection.embeddingModel,
    embeddingDimensions: collection.embeddingDimensions,
    documentCount: collection.documentCount,
    readyDocumentCount: collection.readyDocumentCount,
    chunkCount: collection.chunkCount,
    createdAt: collection.createdAt.toISOString(),
    updatedAt: collection.updatedAt.toISOString(),
  };
}
