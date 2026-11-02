import { sql } from 'drizzle-orm';
import type { AppConfig } from './config/env.js';
import type { Database } from './db/client.js';
import { EMBEDDING_COLUMN_QUERY } from './db/probe.js';
import { EMBEDDING_COLUMN_DIMENSIONS } from './db/schema.js';
import {
  createChunkingService,
  type ChunkingService,
} from './modules/chunking/chunking.service.js';
import type { ChatProvider } from './modules/chat/chat-provider.js';
import { createChatService, type ChatService } from './modules/chat/chat.service.js';
import { createChatProvider } from './modules/chat/create-chat-provider.js';
import { createChunkingStep } from './modules/chunking/chunking.step.js';
import {
  createChunksRepository,
  type ChunksRepository,
} from './modules/chunking/chunks.repository.js';
import { createCollectionsRepository } from './modules/collections/collections.repository.js';
import {
  createCollectionsService,
  type CollectionEmbeddingSettings,
  type CollectionsService,
} from './modules/collections/collections.service.js';
import {
  createDocumentsRepository,
  type DocumentsRepository,
} from './modules/documents/documents.repository.js';
import {
  createDocumentsService,
  type DocumentsService,
} from './modules/documents/documents.service.js';
import { createEmbeddingProvider } from './modules/embeddings/create-embedding-provider.js';
import type { EmbeddingProvider } from './modules/embeddings/embedding-provider.js';
import { createEmbeddingStep } from './modules/embeddings/embedding.step.js';
import {
  createProviderStatusService,
  type ProviderStatusService,
} from './modules/embeddings/provider-status.service.js';
import {
  createDocumentIndexer,
  type DocumentIndexer,
  type IndexerLogger,
  type IndexingStep,
} from './modules/ingestion/document-indexer.js';
import { recoverDocuments, type RecoveryResult } from './modules/ingestion/recovery.js';
import {
  createPlaygroundService,
  type PlaygroundService,
} from './modules/playground/playground.service.js';
import { createRetrievalRepository } from './modules/retrieval/retrieval.repository.js';
import {
  createRetrievalService,
  type RetrievalService,
} from './modules/retrieval/retrieval.service.js';

/** Domain services passed to `buildApp`. Tests substitute fakes (no DI container). */
export interface AppServices {
  collections: CollectionsService;
  documents: DocumentsService;
  chunking: ChunkingService;
  /** Vector search shared by search endpoint, chat, playground, evaluation and MCP. */
  retrieval: RetrievalService;
  /** Grounded answers streamed via SSE (`POST /api/chat`). */
  chat: ChatService;
  /** Retrieval diagnostics (`POST /api/playground/search`); never calls the chat model. */
  playground: PlaygroundService;
  /** Live provider status (`GET /api/system/providers`). */
  providers: ProviderStatusService;
  /** Background processing of uploaded documents; `buildApp` closes it on shutdown. */
  ingestion: IngestionRuntime;
}

/** Lifecycle of the in-process document indexer. */
export interface IngestionRuntime {
  /** `undefined` while no indexing step exists – documents then stay `pending`. */
  readonly indexer: DocumentIndexer | undefined;
  /** Startup recovery: `processing → failed`, re-queue `pending` (see recovery.ts). */
  recover(): Promise<RecoveryResult>;
  /** Aborts running jobs and waits for them to settle (Fastify `onClose`). */
  close(): Promise<void>;
}

/**
 * Indexing steps in execution order: chunking (005), then embedding (006). A document becomes
 * `ready` only after both succeeded, i.e. when every chunk has a vector.
 */
export function createIndexingSteps({
  chunks,
  collections,
  embeddingProvider,
  config,
}: {
  chunks: ChunksRepository;
  collections: Pick<CollectionsService, 'get'>;
  embeddingProvider: EmbeddingProvider;
  config: AppConfig;
}): IndexingStep[] {
  return [
    createChunkingStep({ repository: chunks, options: config.chunking }),
    createEmbeddingStep({
      provider: embeddingProvider,
      chunks,
      collections,
      columnDimensions: EMBEDDING_COLUMN_DIMENSIONS,
    }),
  ];
}

export function createIngestionRuntime({
  repository,
  steps,
  logger,
  concurrency,
}: {
  repository: DocumentsRepository;
  steps: readonly IndexingStep[];
  logger: IndexerLogger;
  concurrency: number;
}): IngestionRuntime {
  const indexer =
    steps.length > 0
      ? createDocumentIndexer({ repository, steps, logger, concurrency })
      : undefined;
  return {
    indexer,
    recover: () => recoverDocuments({ repository, indexer, logger }),
    close: async () => {
      await indexer?.close();
    },
  };
}

export interface CreateServicesOptions {
  /** Indexing steps; defaults to {@link createIndexingSteps}. Tests may pass their own (or none). */
  steps?: readonly IndexingStep[];
  /** Embedding provider; defaults to `createEmbeddingProvider(config)`. Tests pass a fake. */
  embeddingProvider?: EmbeddingProvider;
  /** Chat provider; defaults to `createChatProvider(config)`. Tests pass a fake. */
  chatProvider?: ChatProvider;
  /**
   * Embedding settings stored with new collections; defaults to `config.embedding`. Only the
   * evaluation baseline (`pnpm eval --baseline`) sets it to the settings of its own provider.
   */
  collectionEmbedding?: CollectionEmbeddingSettings;
}

/** Reads the dimension of `chunks.embedding` from the catalog (`null` if missing/undeclared). */
async function readColumnDimensions(db: Database): Promise<number | null> {
  const result = await db.execute<{ dimensions: number }>(sql.raw(EMBEDDING_COLUMN_QUERY));
  const dimensions = result.rows[0]?.dimensions;
  return dimensions !== undefined && dimensions > 0 ? dimensions : null;
}

/** Wires repositories and services against a real database (main.ts and integration tests). */
export function createServices(
  db: Database,
  config: AppConfig,
  logger: IndexerLogger,
  {
    steps,
    embeddingProvider = createEmbeddingProvider(config),
    chatProvider = createChatProvider(config),
    collectionEmbedding = config.embedding,
  }: CreateServicesOptions = {},
): AppServices {
  const collections = createCollectionsService({
    repository: createCollectionsRepository(db),
    embedding: collectionEmbedding,
  });
  const documentsRepository = createDocumentsRepository(db);
  const chunksRepository = createChunksRepository(db);
  const ingestion = createIngestionRuntime({
    repository: documentsRepository,
    steps:
      steps ??
      createIndexingSteps({ chunks: chunksRepository, collections, embeddingProvider, config }),
    logger,
    concurrency: config.ingestion.concurrency,
  });
  const documents = createDocumentsService({
    repository: documentsRepository,
    collections,
    indexer: ingestion.indexer,
    countMissingEmbeddings: (documentId) => chunksRepository.countWithoutEmbedding(documentId),
    maxDocumentsPerCollection: config.upload.maxDocumentsPerCollection,
  });
  const providers = createProviderStatusService({
    embedding: embeddingProvider,
    chat: chatProvider,
    columnDimensions: () => readColumnDimensions(db),
  });
  const chunking = createChunkingService({
    repository: chunksRepository,
    documents,
    defaults: config.chunking,
  });
  const retrieval = createRetrievalService({
    repository: createRetrievalRepository(db),
    embeddingProvider,
    collections,
    config: config.retrieval,
    columnDimensions: EMBEDDING_COLUMN_DIMENSIONS,
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
