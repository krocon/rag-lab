import type { DocumentMetadataFields } from '@raglab/shared';
import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { VECTOR_OPCLASS } from '../modules/retrieval/similarity.js';

/**
 * Drizzle schema – the single source of truth for `drizzle-kit generate`.
 * Target model and rationale: docs/data-model.md.
 */

/**
 * Dimension of `chunks.embedding`. This is a **migration decision**, not configuration:
 * it must equal `EMBEDDING_DIMENSIONS` (see `.env.example`), which the readiness check verifies.
 * Changing it requires a new migration (alter the column, rebuild the HNSW index) and
 * re-embedding every chunk.
 */
export const EMBEDDING_COLUMN_DIMENSIONS = 768;

export const DOCUMENT_STATUSES = ['pending', 'processing', 'ready', 'failed'] as const;

export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const documentStatus = pgEnum('document_status', DOCUMENT_STATUSES);

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`);

const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const collections = pgTable(
  'collections',
  {
    id: id(),
    name: text('name').notNull(),
    description: text('description'),
    embeddingProvider: text('embedding_provider').notNull(),
    embeddingModel: text('embedding_model').notNull(),
    embeddingDimensions: integer('embedding_dimensions').notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('collections_name_lower_unique').on(sql`lower(${table.name})`),
    check('collections_name_length', sql`char_length(${table.name}) BETWEEN 1 AND 120`),
    check(
      'collections_description_length',
      sql`${table.description} IS NULL OR char_length(${table.description}) <= 2000`,
    ),
    check('collections_embedding_dimensions_positive', sql`${table.embeddingDimensions} > 0`),
  ],
);

export const documents = pgTable(
  'documents',
  {
    id: id(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    contentSha256: text('content_sha256').notNull(),
    content: text('content').notNull(),
    status: documentStatus('status').notNull().default('pending'),
    errorMessage: text('error_message'),
    chunkCount: integer('chunk_count').notNull().default(0),
    metadata: jsonb('metadata').$type<DocumentMetadataFields>().notNull().default({}),
    ...timestamps(),
  },
  (table) => [
    // Leading `collection_id` also serves plain collection filters and the FK cascade.
    index('documents_collection_id_status_idx').on(table.collectionId, table.status),
    uniqueIndex('documents_collection_id_content_sha256_unique').on(
      table.collectionId,
      table.contentSha256,
    ),
  ],
);

export const chunks = pgTable(
  'chunks',
  {
    id: id(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    // Denormalised so the vector search can filter by collection without a join.
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    startOffset: integer('start_offset').notNull(),
    endOffset: integer('end_offset').notNull(),
    charCount: integer('char_count').notNull(),
    tokenEstimate: integer('token_estimate'),
    headingPath: text('heading_path')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    embedding: vector('embedding', { dimensions: EMBEDDING_COLUMN_DIMENSIONS }),
    ...timestamps(),
  },
  (table) => [
    // Leading `document_id` also serves the FK cascade from documents.
    uniqueIndex('chunks_document_id_chunk_index_unique').on(table.documentId, table.chunkIndex),
    index('chunks_collection_id_idx').on(table.collectionId),
    // Cosine distance (`<=>`); metric defined once in modules/retrieval/similarity.ts.
    index('chunks_embedding_hnsw_idx').using('hnsw', table.embedding.op(VECTOR_OPCLASS)),
    check('chunks_content_not_blank', sql`length(trim(${table.content})) > 0`),
    check('chunks_chunk_index_non_negative', sql`${table.chunkIndex} >= 0`),
    check(
      'chunks_offsets_valid',
      sql`${table.startOffset} >= 0 AND ${table.endOffset} >= ${table.startOffset}`,
    ),
  ],
);

export const collectionsRelations = relations(collections, ({ many }) => ({
  documents: many(documents),
  chunks: many(chunks),
}));

export const documentsRelations = relations(documents, ({ one, many }) => ({
  collection: one(collections, {
    fields: [documents.collectionId],
    references: [collections.id],
  }),
  chunks: many(chunks),
}));

export const chunksRelations = relations(chunks, ({ one }) => ({
  document: one(documents, { fields: [chunks.documentId], references: [documents.id] }),
  collection: one(collections, { fields: [chunks.collectionId], references: [collections.id] }),
}));

export type Collection = typeof collections.$inferSelect;
export type NewCollection = typeof collections.$inferInsert;
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type Chunk = typeof chunks.$inferSelect;
export type NewChunk = typeof chunks.$inferInsert;
