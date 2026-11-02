import type { DocumentContentResponse, DocumentDto, DocumentStatus } from '@raglab/shared';
import { AppError, badRequest, conflict, isUniqueViolation, notFound } from '../../http/errors.js';
import type { CollectionsService } from '../collections/collections.service.js';
import {
  prepareUpload,
  type PreparedDocument,
  type UploadedFile,
} from '../ingestion/prepare-upload.js';
import {
  DOCUMENT_CONTENT_UNIQUE_INDEX,
  type DocumentMetadata,
  type DocumentsRepository,
  type ExistingDocumentRef,
} from './documents.repository.js';

export interface DocumentsService {
  listByCollection(collectionId: string): Promise<DocumentDto[]>;
  get(id: string): Promise<DocumentDto>;
  /** The normalised text of a document (basis for the source view). */
  getContent(id: string): Promise<DocumentContentResponse>;
  /**
   * Validates every file first, then stores all of them as `pending` documents in one statement
   * (all or nothing) and hands them to the indexer. See docs/architecture.md §4.1.
   */
  upload(collectionId: string, files: AsyncIterable<UploadedFile>): Promise<DocumentDto[]>;
  delete(id: string): Promise<void>;
  /**
   * Queues a document for indexing again (all steps: chunking and embedding). Allowed for
   * `failed` documents and for `ready` documents with chunks that have no embedding.
   */
  reindex(id: string): Promise<DocumentDto>;
}

/** Receives newly stored documents for asynchronous processing (the document indexer). */
export interface IndexingScheduler {
  index(documentId: string): Promise<void>;
}

export interface DocumentsServiceDependencies {
  repository: DocumentsRepository;
  /** Other modules are used through their services only, never through their tables. */
  collections: Pick<CollectionsService, 'assertExists' | 'get'>;
  /**
   * `undefined` when no indexing step is configured (e.g. in tests): documents then stay `pending`
   * instead of being marked `ready` without chunks.
   */
  indexer: IndexingScheduler | undefined;
  /** Number of the document's chunks without an embedding (chunking module). */
  countMissingEmbeddings(documentId: string): Promise<number>;
  /** `MAX_DOCUMENTS_PER_COLLECTION`; `null`/absent = unlimited. */
  maxDocumentsPerCollection?: number | null;
}

export function createDocumentsService({
  repository,
  collections,
  indexer,
  countMissingEmbeddings,
  maxDocumentsPerCollection = null,
}: DocumentsServiceDependencies): DocumentsService {
  const documentNotFound = (id: string) =>
    notFound('DOCUMENT_NOT_FOUND', `Document ${id} does not exist`);

  const documentBusy = (document: { id: string; status: DocumentStatus }) =>
    conflict(
      'DOCUMENT_BUSY',
      `Document ${document.id} is ${document.status}; wait until processing has finished.`,
      { status: document.status },
    );

  const duplicateOfExisting = (prepared: PreparedDocument, existing: ExistingDocumentRef) =>
    conflict(
      'DUPLICATE_DOCUMENT',
      `"${prepared.filename}" has the same content as a document that already exists in this collection.`,
      {
        filename: prepared.filename,
        existingDocumentId: existing.id,
        existingDocumentStatus: existing.status,
      },
    );

  /**
   * Throws `409 DOCUMENT_LIMIT_REACHED` if `adding` more documents would exceed
   * `MAX_DOCUMENTS_PER_COLLECTION`. A soft limit: concurrent uploads may overshoot it slightly.
   */
  async function assertDocumentLimit(collectionId: string, adding: number): Promise<void> {
    if (maxDocumentsPerCollection === null) {
      return;
    }
    const { documentCount } = await collections.get(collectionId);
    if (documentCount + adding > maxDocumentsPerCollection) {
      throw conflict(
        'DOCUMENT_LIMIT_REACHED',
        `The collection can hold at most ${maxDocumentsPerCollection} documents (it has ${documentCount}).`,
        { maxDocuments: maxDocumentsPerCollection, documentCount },
      );
    }
  }

  /** Throws `409 DUPLICATE_DOCUMENT` if one of the prepared documents already exists. */
  async function assertNoExistingDuplicates(
    collectionId: string,
    prepared: PreparedDocument[],
  ): Promise<void> {
    const existing = await repository.findByContentHashes(
      collectionId,
      prepared.map((document) => document.contentSha256),
    );
    for (const document of prepared) {
      const match = existing.find((row) => row.contentSha256 === document.contentSha256);
      if (match) {
        throw duplicateOfExisting(document, match);
      }
    }
  }

  return {
    async listByCollection(collectionId) {
      await collections.assertExists(collectionId);
      return (await repository.listByCollection(collectionId)).map(toDocumentDto);
    },

    async get(id) {
      const document = await repository.findById(id);
      if (!document) {
        throw documentNotFound(id);
      }
      return toDocumentDto(document);
    },

    async getContent(id) {
      const document = await repository.findContent(id);
      if (!document) {
        throw documentNotFound(id);
      }
      return { documentId: document.id, content: document.content };
    },

    async upload(collectionId, files) {
      // 404 (and a full collection) before any file is read.
      await collections.assertExists(collectionId);
      await assertDocumentLimit(collectionId, 1);

      // 1. Validate and normalise every file; the first invalid file fails the whole request.
      const prepared: PreparedDocument[] = [];
      for await (const file of files) {
        const document = await prepareUpload(file);
        const sameInRequest = prepared.find(
          (other) => other.contentSha256 === document.contentSha256,
        );
        if (sameInRequest) {
          throw conflict(
            'DUPLICATE_DOCUMENT',
            `"${document.filename}" has the same content as "${sameInRequest.filename}" in this upload.`,
            { filename: document.filename, duplicateOfFilename: sameInRequest.filename },
          );
        }
        prepared.push(document);
      }
      if (prepared.length === 0) {
        throw badRequest('NO_FILE', 'The request contains no file. Send at least one file.');
      }

      // 2. Duplicates per collection (same normalised content → same hash), document limit.
      await assertNoExistingDuplicates(collectionId, prepared);
      await assertDocumentLimit(collectionId, prepared.length);

      // 3. Store all documents as `pending` in one statement.
      let inserted: DocumentMetadata[];
      try {
        inserted = await repository.insertMany(
          prepared.map((document) => ({
            collectionId,
            filename: document.filename,
            mimeType: document.mimeType,
            sizeBytes: document.sizeBytes,
            contentSha256: document.contentSha256,
            content: document.content,
            metadata: { ...document.metadata },
          })),
        );
      } catch (error) {
        // A concurrent upload of the same content won the race for the unique index.
        if (isUniqueViolation(error, DOCUMENT_CONTENT_UNIQUE_INDEX)) {
          await assertNoExistingDuplicates(collectionId, prepared);
        }
        throw error;
      }

      // 4. Hand over to the indexer without awaiting it (the client polls the status).
      const byHash = new Map(inserted.map((document) => [document.contentSha256, document]));
      const ordered = prepared.flatMap((document) => byHash.get(document.contentSha256) ?? []);
      for (const document of ordered) {
        void indexer?.index(document.id);
      }
      return ordered.map(toDocumentDto);
    },

    async delete(id) {
      if (!(await repository.delete(id))) {
        throw documentNotFound(id);
      }
    },

    async reindex(id) {
      const document = await repository.findById(id);
      if (!document) {
        throw documentNotFound(id);
      }
      if (document.status === 'pending' || document.status === 'processing') {
        throw documentBusy(document);
      }
      if (document.status === 'ready' && (await countMissingEmbeddings(id)) === 0) {
        throw conflict(
          'DOCUMENT_ALREADY_INDEXED',
          `Document ${id} is already indexed: all of its chunks have embeddings.`,
          { status: document.status },
        );
      }
      if (!indexer) {
        throw new AppError(
          503,
          'INDEXING_UNAVAILABLE',
          'Document indexing is not available on this server.',
        );
      }
      // Conditional update: a concurrent reindex or status change makes this a no-op.
      const requeued = await repository.requeue(id, document.status);
      if (!requeued) {
        const current = await repository.findById(id);
        throw current ? documentBusy(current) : documentNotFound(id);
      }
      void indexer.index(id);
      return toDocumentDto(requeued);
    },
  };
}

export function toDocumentDto(document: DocumentMetadata): DocumentDto {
  return {
    id: document.id,
    collectionId: document.collectionId,
    filename: document.filename,
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    contentSha256: document.contentSha256,
    status: document.status,
    errorMessage: document.errorMessage,
    chunkCount: document.chunkCount,
    metadata: document.metadata,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  };
}
