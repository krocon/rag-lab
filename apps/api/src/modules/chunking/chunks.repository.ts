import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { chunks, type NewChunk } from '../../db/schema.js';
import { toVectorLiteral } from '../../db/vector.js';
import type { ChunkDraft } from './chunker.js';

/** Keys of `chunks.metadata` written by the chunker. */
export interface ChunkMetadataFields {
  /** Length of the leading part repeated from the preceding chunk. */
  overlapChars?: number;
  /** 1-based line range (chunks stored since prompt 017). */
  startLine?: number;
  endLine?: number;
  /** Enclosing top-level declaration(s) of source code. */
  symbol?: string;
  [key: string]: unknown;
}

/** A stored chunk without its embedding vector. */
export interface StoredChunk {
  id: string;
  documentId: string;
  collectionId: string;
  chunkIndex: number;
  content: string;
  startOffset: number;
  endOffset: number;
  charCount: number;
  tokenEstimate: number | null;
  headingPath: string[];
  metadata: ChunkMetadataFields;
  hasEmbedding: boolean;
  createdAt: Date;
}

/** Data access for the `chunks` table, owned by the chunking module. */
export interface ChunksRepository {
  /**
   * Replaces all chunks of a document in **one transaction**: either the complete new set is
   * stored or the previous state stays untouched (no partial chunk sets).
   */
  replaceForDocument(
    document: { id: string; collectionId: string },
    drafts: readonly ChunkDraft[],
  ): Promise<void>;
  /** Chunks of a document ordered by `chunk_index`. */
  listByDocument(documentId: string): Promise<StoredChunk[]>;
  /** Id and text of every chunk of the document that has no embedding yet, by `chunk_index`. */
  listWithoutEmbedding(documentId: string): Promise<ChunkToEmbed[]>;
  /** Number of chunks of the document without an embedding. */
  countWithoutEmbedding(documentId: string): Promise<number>;
  /**
   * Stores the vectors of a document's chunks in **one transaction**. Throws (and stores
   * nothing) if any chunk no longer exists, e.g. because the document was deleted meanwhile.
   */
  storeEmbeddings(documentId: string, embeddings: readonly ChunkEmbedding[]): Promise<void>;
}

export interface ChunkToEmbed {
  id: string;
  content: string;
  headingPath: string[];
  metadata: ChunkMetadataFields;
}

export interface ChunkEmbedding {
  chunkId: string;
  embedding: readonly number[];
}

/** Rows per INSERT statement – far below PostgreSQL's limit of 65,535 bind parameters. */
const INSERT_BATCH_SIZE = 500;

/** Vectors per UPDATE statement (each vector is one text parameter of ~10–20 KB). */
const EMBEDDING_UPDATE_BATCH_SIZE = 100;

export function createChunksRepository(db: Database): ChunksRepository {
  return {
    async replaceForDocument(document, drafts) {
      await db.transaction(async (tx) => {
        await tx.delete(chunks).where(eq(chunks.documentId, document.id));
        for (let index = 0; index < drafts.length; index += INSERT_BATCH_SIZE) {
          const rows: NewChunk[] = drafts
            .slice(index, index + INSERT_BATCH_SIZE)
            .map((draft) => toRow(document, draft));
          await tx.insert(chunks).values(rows);
        }
      });
    },

    listByDocument: (documentId) =>
      db
        .select({
          id: chunks.id,
          documentId: chunks.documentId,
          collectionId: chunks.collectionId,
          chunkIndex: chunks.chunkIndex,
          content: chunks.content,
          startOffset: chunks.startOffset,
          endOffset: chunks.endOffset,
          charCount: chunks.charCount,
          tokenEstimate: chunks.tokenEstimate,
          headingPath: chunks.headingPath,
          metadata: chunks.metadata,
          // The vector itself is never loaded here.
          hasEmbedding: sql<boolean>`${chunks.embedding} IS NOT NULL`,
          createdAt: chunks.createdAt,
        })
        .from(chunks)
        .where(eq(chunks.documentId, documentId))
        .orderBy(asc(chunks.chunkIndex)),

    listWithoutEmbedding: (documentId) =>
      db
        .select({
          id: chunks.id,
          content: chunks.content,
          headingPath: chunks.headingPath,
          metadata: chunks.metadata,
        })
        .from(chunks)
        .where(and(eq(chunks.documentId, documentId), isNull(chunks.embedding)))
        .orderBy(asc(chunks.chunkIndex)),

    async countWithoutEmbedding(documentId) {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(chunks)
        .where(and(eq(chunks.documentId, documentId), isNull(chunks.embedding)));
      return rows[0]?.count ?? 0;
    },

    async storeEmbeddings(documentId, embeddings) {
      await db.transaction(async (tx) => {
        for (let index = 0; index < embeddings.length; index += EMBEDDING_UPDATE_BATCH_SIZE) {
          const batch = embeddings.slice(index, index + EMBEDDING_UPDATE_BATCH_SIZE);
          const values = sql.join(
            batch.map(
              (row) => sql`(${row.chunkId}::uuid, ${toVectorLiteral(row.embedding)}::vector)`,
            ),
            sql`, `,
          );
          const result = await tx.execute(sql`
            UPDATE ${chunks} AS c
               SET embedding = v.embedding, updated_at = now()
              FROM (VALUES ${values}) AS v(id, embedding)
             WHERE c.id = v.id AND c.document_id = ${documentId}`);
          if (result.rowCount !== batch.length) {
            // Rolls the whole transaction back: no partially embedded document.
            throw new Error(
              `stored ${result.rowCount ?? 0} of ${batch.length} embeddings: chunks changed meanwhile`,
            );
          }
        }
      });
    },
  };
}

function toRow(document: { id: string; collectionId: string }, draft: ChunkDraft): NewChunk {
  return {
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
    } satisfies ChunkMetadataFields,
  };
}
