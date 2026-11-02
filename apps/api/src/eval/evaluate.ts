import type { AppServices } from '../services.js';
import {
  matchedAnchorIds,
  unresolvedAnchors,
  type ChunkRef,
  type DatasetDocument,
  type EvalDataset,
} from './dataset.js';
import {
  averageLevelMetrics,
  computeLevelMetrics,
  type LevelMetrics,
  type RankedItem,
} from './metrics.js';

/** Cut-offs reported for every run (prompt 013). */
export const DEFAULT_KS = [1, 3, 5, 10] as const;

/** Services the evaluation uses – the real ones, exactly as the API wires them. */
export type EvalServices = Pick<
  AppServices,
  'collections' | 'documents' | 'chunking' | 'retrieval' | 'ingestion'
>;

/** Expected failures with a message for humans (no stack trace needed). */
export class EvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalError';
  }
}

export interface RetrievedHit {
  rank: number;
  filename: string;
  chunkIndex: number;
  headingPath: string[];
  score: number;
  /** The chunk belongs to a relevant document. */
  documentRelevant: boolean;
  /** Ids of the query's anchors this chunk matches. */
  matchedAnchors: string[];
}

export interface QueryEvaluation {
  id: string;
  query: string;
  relevantDocuments: string[];
  relevantAnchors: string[];
  results: RetrievedHit[];
  document: LevelMetrics;
  section: LevelMetrics;
}

export interface EvaluationRun {
  collectionId: string;
  /** The collection was kept (`--keep`) instead of deleted. */
  kept: boolean;
  ks: number[];
  /** Number of results requested per query (`max(ks)`). */
  topK: number;
  indexing: { documents: number; chunks: number; durationMs: number };
  /** Anchors that no stored chunk matches (see `unresolvedAnchors`). */
  unresolvedAnchors: string[];
  queries: QueryEvaluation[];
  summary: { document: LevelMetrics; section: LevelMetrics };
  searchDurationMs: number;
}

export interface EvaluationOptions {
  services: EvalServices;
  dataset: EvalDataset;
  collectionName: string;
  ks?: readonly number[];
  /** Keep the collection after the run (default: delete it). */
  keep?: boolean;
  signal?: AbortSignal;
  /** Progress lines for the CLI (no document content). */
  onProgress?: (message: string) => void;
}

/**
 * Indexes a dataset into a temporary collection through the real services (upload validation,
 * normalisation, chunking, embedding), runs every query through the retrieval service and computes
 * the metrics. The collection is deleted afterwards – also on failure or abort – unless `keep`.
 */
export async function runEvaluation({
  services,
  dataset,
  collectionName,
  ks = DEFAULT_KS,
  keep = false,
  signal,
  onProgress = () => undefined,
}: EvaluationOptions): Promise<EvaluationRun> {
  const cutoffs = [...new Set(ks)].sort((a, b) => a - b);
  const topK = cutoffs.at(-1);
  if (topK === undefined) {
    throw new EvalError('At least one K is required.');
  }

  const collection = await services.collections.create({
    name: collectionName,
    description: `Temporary evaluation collection (dataset ${dataset.name}).`,
  });
  try {
    onProgress(`Indexing ${dataset.documents.length} documents into "${collectionName}" …`);
    const indexingStart = performance.now();
    const chunks = await indexDocuments(services, collection.id, dataset.documents, signal);
    const indexingMs = Math.round(performance.now() - indexingStart);
    onProgress(
      `Indexed ${chunks.length} chunks in ${indexingMs} ms. Running ${dataset.queries.length} queries …`,
    );

    const queries: QueryEvaluation[] = [];
    const searchStart = performance.now();
    for (const query of dataset.queries) {
      signal?.throwIfAborted();
      const response = await services.retrieval.search(
        { collectionId: collection.id, query: query.query, topK },
        signal,
      );
      const relevantDocuments = [...new Set(query.anchors.map((anchor) => anchor.document))];
      const results: RetrievedHit[] = response.results.map((result) => ({
        rank: result.rank,
        filename: result.filename,
        chunkIndex: result.chunkIndex,
        headingPath: result.headingPath,
        score: result.score,
        documentRelevant: relevantDocuments.includes(result.filename),
        matchedAnchors: matchedAnchorIds(query.anchors, result),
      }));
      const documentRanking: RankedItem[] = results.map((hit) => [hit.filename]);
      const sectionRanking: RankedItem[] = results.map((hit) => hit.matchedAnchors);
      queries.push({
        id: query.id,
        query: query.query,
        relevantDocuments,
        relevantAnchors: query.anchors.map((anchor) => anchor.id),
        results,
        document: computeLevelMetrics(documentRanking, new Set(relevantDocuments), cutoffs),
        section: computeLevelMetrics(
          sectionRanking,
          new Set(query.anchors.map((anchor) => anchor.id)),
          cutoffs,
        ),
      });
    }
    const searchDurationMs = Math.round(performance.now() - searchStart);

    return {
      collectionId: collection.id,
      kept: keep,
      ks: cutoffs,
      topK,
      indexing: {
        documents: dataset.documents.length,
        chunks: chunks.length,
        durationMs: indexingMs,
      },
      unresolvedAnchors: unresolvedAnchors(dataset.queries, chunks),
      queries,
      summary: {
        document: averageLevelMetrics(
          queries.map((query) => query.document),
          cutoffs,
        ),
        section: averageLevelMetrics(
          queries.map((query) => query.section),
          cutoffs,
        ),
      },
      searchDurationMs,
    };
  } finally {
    if (!keep) {
      await services.collections.delete(collection.id);
    }
  }
}

/**
 * Uploads every document (one per call, so `MAX_UPLOAD_FILES` never applies), waits for the
 * indexer and returns all stored chunks. Fails if a document does not become `ready`.
 */
async function indexDocuments(
  services: EvalServices,
  collectionId: string,
  documents: readonly DatasetDocument[],
  signal: AbortSignal | undefined,
): Promise<ChunkRef[]> {
  const indexer = services.ingestion.indexer;
  if (!indexer) {
    throw new EvalError('No indexing steps are configured – documents would never become ready.');
  }
  const uploaded: { id: string; filename: string }[] = [];
  for (const document of documents) {
    signal?.throwIfAborted();
    const bytes = new TextEncoder().encode(document.raw);
    const [stored] = await services.documents.upload(
      collectionId,
      (async function* () {
        yield { filename: document.filename, read: async () => bytes };
      })(),
    );
    if (!stored) {
      throw new EvalError(`Upload of ${document.filename} returned no document.`);
    }
    uploaded.push({ id: stored.id, filename: stored.filename });
  }
  // `index` returns the already scheduled run of the upload, so this waits for all of them.
  await Promise.all(uploaded.map((document) => indexer.index(document.id)));
  signal?.throwIfAborted();

  const chunks: ChunkRef[] = [];
  for (const { id, filename } of uploaded) {
    const document = await services.documents.get(id);
    if (document.status !== 'ready') {
      throw new EvalError(
        `Indexing ${filename} failed (${document.status}): ${document.errorMessage ?? 'unknown reason'}`,
      );
    }
    const stored = await services.chunking.listByDocument(id);
    chunks.push(
      ...stored.chunks.map((chunk) => ({
        filename,
        headingPath: chunk.headingPath,
        content: chunk.content,
      })),
    );
  }
  return chunks;
}
