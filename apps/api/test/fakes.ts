import { randomUUID } from 'node:crypto';
import { createChunkingService } from '../src/modules/chunking/chunking.service.js';
import type { ChunksRepository, StoredChunk } from '../src/modules/chunking/chunks.repository.js';
import {
  COLLECTION_NAME_UNIQUE_INDEX,
  type CollectionsRepository,
  type CollectionWithStats,
} from '../src/modules/collections/collections.repository.js';
import { createCollectionsService } from '../src/modules/collections/collections.service.js';
import {
  DOCUMENT_CONTENT_UNIQUE_INDEX,
  DOCUMENT_PATH_UNIQUE_INDEX,
  type DocumentMetadata,
  type DocumentsRepository,
} from '../src/modules/documents/documents.repository.js';
import { createDocumentsService } from '../src/modules/documents/documents.service.js';
import type { IndexerLogger, IndexingStep } from '../src/modules/ingestion/document-indexer.js';
import type { AppConfig } from '../src/config/env.js';
import type { DatabaseProbe } from '../src/db/probe.js';
import type { EmbeddingProvider } from '../src/modules/embeddings/embedding-provider.js';
import { createProviderStatusService } from '../src/modules/embeddings/provider-status.service.js';
import type { RetrievalRepository } from '../src/modules/retrieval/retrieval.repository.js';
import { createRetrievalService } from '../src/modules/retrieval/retrieval.service.js';
import type { ChatProvider } from '../src/modules/chat/chat-provider.js';
import { createChatService } from '../src/modules/chat/chat.service.js';
import { createPlaygroundService } from '../src/modules/playground/playground.service.js';
import { createIngestionRuntime, type AppServices } from '../src/services.js';
import { createFakeChatProvider } from './fakes/fake-chat-provider.js';
import { createFakeEmbeddingProvider } from './fakes/fake-embedding-provider.js';

/** Mimics the error the pg driver raises for a unique violation. */
export function uniqueViolation(constraint: string): Error {
  return Object.assign(
    new Error(`duplicate key value violates unique constraint "${constraint}"`),
    {
      code: '23505',
      constraint,
    },
  );
}

/** A stored document; `content` is optional so metadata-only fixtures can be stored as well. */
export type StoredDocument = DocumentMetadata & { content?: string };

/** In-memory stand-in for the Drizzle repositories (no database). */
export interface InMemoryStore {
  collections: Map<string, CollectionWithStats>;
  documents: Map<string, StoredDocument>;
  /** Chunks per document id, ordered by `chunkIndex`. */
  chunks: Map<string, StoredChunk[]>;
  /** Stored vectors per chunk id. */
  embeddings: Map<string, readonly number[]>;
}

export function createInMemoryStore(): InMemoryStore {
  return { collections: new Map(), documents: new Map(), chunks: new Map(), embeddings: new Map() };
}

export function createInMemoryChunksRepository(store: InMemoryStore): ChunksRepository {
  return {
    replaceForDocument: async (document, drafts) => {
      const createdAt = new Date();
      store.chunks.set(
        document.id,
        drafts.map((draft) => ({
          id: randomUUID(),
          documentId: document.id,
          collectionId: document.collectionId,
          chunkIndex: draft.chunkIndex,
          content: draft.content,
          startOffset: draft.startOffset,
          endOffset: draft.endOffset,
          charCount: draft.charCount,
          tokenEstimate: draft.tokenEstimate,
          headingPath: draft.headingPath,
          metadata: {
            overlapChars: draft.overlapChars,
            startLine: draft.startLine,
            endLine: draft.endLine,
            ...(draft.symbol === null ? {} : { symbol: draft.symbol }),
          },
          hasEmbedding: false,
          createdAt,
        })),
      );
    },
    listByDocument: async (documentId) => store.chunks.get(documentId) ?? [],
    listWithoutEmbedding: async (documentId) =>
      (store.chunks.get(documentId) ?? [])
        .filter((chunk) => !chunk.hasEmbedding)
        .map(({ id, content, headingPath, metadata }) => ({ id, content, headingPath, metadata })),
    countWithoutEmbedding: async (documentId) =>
      (store.chunks.get(documentId) ?? []).filter((chunk) => !chunk.hasEmbedding).length,
    storeEmbeddings: async (documentId, embeddings) => {
      const chunks = store.chunks.get(documentId) ?? [];
      // All or nothing, like the transaction of the real repository.
      if (!embeddings.every((row) => chunks.some((chunk) => chunk.id === row.chunkId))) {
        throw new Error('chunks changed meanwhile');
      }
      for (const row of embeddings) {
        store.embeddings.set(row.chunkId, row.embedding);
        const chunk = chunks.find((candidate) => candidate.id === row.chunkId);
        if (chunk) {
          chunk.hasEmbedding = true;
        }
      }
    },
  };
}

/** Cosine distance like pgvector's `<=>` (0..2). */
export function cosineDistance(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  a.forEach((value, index) => {
    const other = b[index] ?? 0;
    dot += value * other;
    normA += value * value;
    normB += other * other;
  });
  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return 1 - Math.max(-1, Math.min(1, similarity));
}

/**
 * Exact (brute-force) stand-in for the pgvector search: same filters as the SQL – collection,
 * stored embedding, document status `ready`.
 */
export function createInMemoryRetrievalRepository(store: InMemoryStore): RetrievalRepository {
  return {
    search: async ({ collectionId, embedding, limit }) => {
      const rows = [];
      for (const document of store.documents.values()) {
        if (document.collectionId !== collectionId || document.status !== 'ready') {
          continue;
        }
        for (const chunk of store.chunks.get(document.id) ?? []) {
          const vector = store.embeddings.get(chunk.id);
          if (!vector) {
            continue;
          }
          rows.push({
            chunkId: chunk.id,
            documentId: document.id,
            filename: document.filename,
            path: document.path ?? null,
            mimeType: document.mimeType,
            chunkIndex: chunk.chunkIndex,
            content: chunk.content,
            headingPath: chunk.headingPath,
            startOffset: chunk.startOffset,
            endOffset: chunk.endOffset,
            metadata: chunk.metadata,
            distance: cosineDistance(vector, embedding),
          });
        }
      }
      return rows.sort((a, b) => a.distance - b.distance).slice(0, limit);
    },
  };
}

export function createInMemoryCollectionsRepository(store: InMemoryStore): CollectionsRepository {
  const assertUniqueName = (name: string, exceptId?: string) => {
    for (const collection of store.collections.values()) {
      if (collection.id !== exceptId && collection.name.toLowerCase() === name.toLowerCase()) {
        throw uniqueViolation(COLLECTION_NAME_UNIQUE_INDEX);
      }
    }
  };
  const withStats = (collection: CollectionWithStats): CollectionWithStats => {
    const documents = [...store.documents.values()].filter(
      (document) => document.collectionId === collection.id,
    );
    return {
      ...collection,
      documentCount: documents.length,
      readyDocumentCount: documents.filter((document) => document.status === 'ready').length,
      chunkCount: documents.reduce((sum, document) => sum + document.chunkCount, 0),
    };
  };

  return {
    list: async () => [...store.collections.values()].map(withStats),
    findById: async (id) => {
      const collection = store.collections.get(id);
      return collection ? withStats(collection) : undefined;
    },
    exists: async (id) => store.collections.has(id),
    insert: async (record) => {
      assertUniqueName(record.name);
      const now = new Date();
      const collection: CollectionWithStats = {
        id: randomUUID(),
        ...record,
        source: null,
        createdAt: now,
        updatedAt: now,
        documentCount: 0,
        readyDocumentCount: 0,
        chunkCount: 0,
      };
      store.collections.set(collection.id, collection);
      return collection;
    },
    update: async (id, patch) => {
      const existing = store.collections.get(id);
      if (!existing) {
        return undefined;
      }
      if (patch.name !== undefined) {
        assertUniqueName(patch.name, id);
      }
      const updated = { ...existing, ...patch, updatedAt: new Date() };
      store.collections.set(id, updated);
      return withStats(updated);
    },
    delete: async (id) => {
      for (const [documentId, document] of store.documents) {
        if (document.collectionId === id) {
          store.documents.delete(documentId);
        }
      }
      return store.collections.delete(id);
    },
    indexStats: async (id) => {
      const documents = [...store.documents.values()].filter(
        (document) => document.collectionId === id,
      );
      const documentsByStatus = { pending: 0, processing: 0, ready: 0, failed: 0 };
      let chunkCount = 0;
      let searchableChunkCount = 0;
      let chunksWithoutEmbedding = 0;
      for (const document of documents) {
        documentsByStatus[document.status]++;
        for (const chunk of store.chunks.get(document.id) ?? []) {
          chunkCount++;
          const embedded = store.embeddings.has(chunk.id);
          if (!embedded) {
            chunksWithoutEmbedding++;
          } else if (document.status === 'ready') {
            searchableChunkCount++;
          }
        }
      }
      return {
        documentCount: documents.length,
        documentsByStatus,
        chunkCount,
        searchableChunkCount,
        chunksWithoutEmbedding,
      };
    },
  };
}

export function createInMemoryDocumentsRepository(store: InMemoryStore): DocumentsRepository {
  const all = () => [...store.documents.values()];
  const update = (id: string, patch: Partial<StoredDocument>) => {
    const existing = store.documents.get(id);
    if (existing) {
      store.documents.set(id, { ...existing, ...patch, updatedAt: new Date() });
    }
  };
  return {
    listByCollection: async (collectionId, filter = {}) => {
      const matching = all()
        .filter((document) => document.collectionId === collectionId)
        .filter(
          (document) =>
            !filter.pathPrefix || (document.path ?? null)?.startsWith(filter.pathPrefix) === true,
        )
        .sort((a, b) => {
          const pathA = a.path ?? null;
          const pathB = b.path ?? null;
          if (pathA !== pathB) {
            if (pathA === null) return 1;
            if (pathB === null) return -1;
            return pathA < pathB ? -1 : 1;
          }
          return a.createdAt.getTime() - b.createdAt.getTime();
        })
        .map(withoutContent);
      const offset = filter.offset ?? 0;
      const items =
        filter.limit === undefined ? matching : matching.slice(offset, offset + filter.limit);
      return { items, total: matching.length };
    },
    findById: async (id) => store.documents.get(id),
    findContent: async (id) => {
      const document = store.documents.get(id);
      return document ? { id: document.id, content: document.content ?? '' } : undefined;
    },
    findByContentHashes: async (collectionId, hashes) =>
      all()
        .filter(
          (document) =>
            document.collectionId === collectionId && hashes.includes(document.contentSha256),
        )
        .map(({ id, contentSha256, path, status }) => ({
          id,
          contentSha256,
          path: path ?? null,
          status,
        })),
    findByPaths: async (collectionId, paths) =>
      all()
        .filter(
          (document) =>
            document.collectionId === collectionId &&
            document.path !== null &&
            document.path !== undefined &&
            paths.includes(document.path),
        )
        .map(({ id, contentSha256, path, status }) => ({
          id,
          contentSha256,
          path: path ?? null,
          status,
        })),
    insertMany: async (records) => {
      for (const record of records) {
        const clash = all().some(
          (document) =>
            document.collectionId === record.collectionId &&
            document.contentSha256 === record.contentSha256,
        );
        if (clash) {
          throw uniqueViolation(DOCUMENT_CONTENT_UNIQUE_INDEX);
        }
        const pathClash =
          record.path !== null &&
          record.path !== undefined &&
          all().some(
            (document) =>
              document.collectionId === record.collectionId && document.path === record.path,
          );
        if (pathClash) {
          throw uniqueViolation(DOCUMENT_PATH_UNIQUE_INDEX);
        }
      }
      return records.map((record) => {
        const now = new Date();
        const document: StoredDocument = {
          id: randomUUID(),
          ...record,
          path: record.path ?? null,
          metadata: record.metadata ?? {},
          status: 'pending',
          errorMessage: null,
          chunkCount: 0,
          createdAt: now,
          updatedAt: now,
        };
        store.documents.set(document.id, document);
        return withoutContent(document);
      });
    },
    delete: async (id) => {
      store.chunks.delete(id);
      return store.documents.delete(id);
    },
    requeue: async (id, from) => {
      const document = store.documents.get(id);
      if (document?.status !== from) {
        return undefined;
      }
      update(id, { status: 'pending', errorMessage: null });
      const updated = store.documents.get(id);
      return updated ? withoutContent(updated) : undefined;
    },
    claimForProcessing: async (id) => {
      const document = store.documents.get(id);
      if (!document || (document.status !== 'pending' && document.status !== 'failed')) {
        return undefined;
      }
      update(id, { status: 'processing', errorMessage: null });
      return {
        id,
        collectionId: document.collectionId,
        filename: document.filename,
        path: document.path ?? null,
        mimeType: document.mimeType,
        content: document.content ?? '',
      };
    },
    markReady: async (id, chunkCount) => {
      if (store.documents.get(id)?.status === 'processing') {
        update(id, { status: 'ready', chunkCount, errorMessage: null });
      }
    },
    markFailed: async (id, errorMessage) => {
      if (store.documents.get(id)?.status === 'processing') {
        update(id, { status: 'failed', errorMessage });
      }
    },
    failInterrupted: async (errorMessage) => {
      const processing = all().filter((document) => document.status === 'processing');
      for (const document of processing) {
        update(document.id, { status: 'failed', errorMessage });
      }
      return processing.length;
    },
    listPendingIds: async () =>
      all()
        .filter((document) => document.status === 'pending')
        .map((document) => document.id),
  };
}

function withoutContent(document: StoredDocument): DocumentMetadata {
  const metadata = { ...document };
  delete metadata.content;
  return metadata;
}

/** Logger that records every call, e.g. to assert that no document content is logged. */
export interface RecordingLogger extends IndexerLogger {
  entries: { level: 'info' | 'warn' | 'error'; object: object; message: string }[];
}

export function createRecordingLogger(): RecordingLogger {
  const entries: RecordingLogger['entries'] = [];
  return {
    entries,
    info: (object, message) => entries.push({ level: 'info', object, message }),
    warn: (object, message) => entries.push({ level: 'warn', object, message }),
    error: (object, message) => entries.push({ level: 'error', object, message }),
  };
}

/** Real services on top of in-memory repositories – exercises service logic without a DB. */
export function createInMemoryServices(
  config: AppConfig,
  store: InMemoryStore = createInMemoryStore(),
  {
    steps = [],
    logger = createRecordingLogger(),
    embeddingProvider = createFakeEmbeddingProvider(),
    chatProvider = createFakeChatProvider(),
    columnDimensions = async () => 768,
  }: {
    steps?: IndexingStep[];
    logger?: IndexerLogger;
    embeddingProvider?: EmbeddingProvider;
    chatProvider?: ChatProvider;
    columnDimensions?: () => Promise<number | null>;
  } = {},
): AppServices {
  const collections = createCollectionsService({
    repository: createInMemoryCollectionsRepository(store),
    embedding: config.embedding,
  });
  const repository = createInMemoryDocumentsRepository(store);
  const ingestion = createIngestionRuntime({
    repository,
    steps,
    logger,
    concurrency: config.ingestion.concurrency,
  });
  const chunksRepository = createInMemoryChunksRepository(store);
  const documents = createDocumentsService({
    repository,
    collections,
    indexer: ingestion.indexer,
    countMissingEmbeddings: (documentId) => chunksRepository.countWithoutEmbedding(documentId),
    maxDocumentsPerCollection: config.upload.maxDocumentsPerCollection,
  });
  const chunking = createChunkingService({
    repository: chunksRepository,
    documents,
    defaults: config.chunking,
  });
  const providers = createProviderStatusService({
    embedding: embeddingProvider,
    chat: chatProvider,
    columnDimensions,
  });
  const retrieval = createRetrievalService({
    repository: createInMemoryRetrievalRepository(store),
    embeddingProvider,
    collections,
    config: config.retrieval,
    columnDimensions: 768,
  });
  const chat = createChatService({ retrieval, provider: chatProvider, config: config.chat });
  const playground = createPlaygroundService({
    retrieval,
    collections,
    chat: config.chat,
    chatModel: { provider: chatProvider.id, model: chatProvider.model },
  });
  return { collections, documents, chunking, retrieval, chat, playground, providers, ingestion };
}

export function fakeDocument(overrides: Partial<DocumentMetadata> = {}): DocumentMetadata {
  const now = new Date('2026-11-02T10:00:00.000Z');
  return {
    id: randomUUID(),
    collectionId: randomUUID(),
    filename: 'guide.md',
    path: null,
    mimeType: 'text/markdown',
    sizeBytes: 42,
    contentSha256: 'a'.repeat(64),
    status: 'ready',
    errorMessage: null,
    chunkCount: 3,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export const healthyProbe: DatabaseProbe = {
  check: async () => ({
    database: { status: 'up', latencyMs: 1 },
    pgvector: { status: 'up', version: '0.8.7' },
    schema: { status: 'up', expected: 768, actual: 768 },
  }),
};
