import type {
  PlaygroundCollectionStats,
  PlaygroundSearchRequest,
  PlaygroundSearchResponse,
  PlaygroundWarning,
  RetrievalEmptyReason,
} from '@raglab/shared';
import type { AppConfig } from '../../config/env.js';
import { badRequest } from '../../http/errors.js';
import { buildGroundedPrompt, NO_SOURCES_ANSWER } from '../chat/prompt-builder.js';
import type { CollectionsService } from '../collections/collections.service.js';
import { efSearchFor, ITERATIVE_SCAN_MODE } from '../retrieval/retrieval.repository.js';
import { embeddingHeader } from '../embeddings/embedding-text.js';
import { applyMinScore, type RetrievalService } from '../retrieval/retrieval.service.js';
import { DISTANCE_OPERATOR } from '../retrieval/similarity.js';

export interface PlaygroundService {
  /**
   * Runs the retrieval exactly like chat would and adds diagnostics: which results chat would
   * send to the model, index statistics, search settings, warnings and – on request – the prompt
   * messages. Never calls the chat model.
   *
   * Errors (`AppError`) are those of `RetrievalService.search` (`400 VALIDATION_ERROR`,
   * `404 COLLECTION_NOT_FOUND`, `409 EMBEDDING_MODEL_MISMATCH`, `502/503` embedding provider).
   */
  search(request: PlaygroundSearchRequest, signal?: AbortSignal): Promise<PlaygroundSearchResponse>;
}

export interface PlaygroundServiceDependencies {
  /** The retrieval service chat uses – unchanged, no second search implementation. */
  retrieval: Pick<RetrievalService, 'search'>;
  collections: Pick<CollectionsService, 'get' | 'getIndexStats'>;
  /** Chat settings that decide the prompt (`CHAT_CONTEXT_CHAR_BUDGET`, `MAX_QUESTION_CHARS`). */
  chat: Pick<AppConfig['chat'], 'contextCharBudget' | 'maxQuestionChars'>;
  /** Configured chat provider and model, shown with the prompt preview. */
  chatModel: { provider: string; model: string };
  /** The chat prompt builder; replaceable in tests. */
  buildPrompt?: typeof buildGroundedPrompt;
}

const MIN_SCORE_LOWER = -1;
const MIN_SCORE_UPPER = 1;

export function createPlaygroundService({
  retrieval,
  collections,
  chat,
  chatModel,
  buildPrompt = buildGroundedPrompt,
}: PlaygroundServiceDependencies): PlaygroundService {
  return {
    async search(request, signal) {
      const minScore = validateMinScore(request.minScore);

      // Without `minScore`, so results below it can be shown (flagged) instead of disappearing.
      // Validation, 404 and model mismatch come from the retrieval service, as in chat.
      const search = await retrieval.search(
        {
          collectionId: request.collectionId,
          query: request.query,
          ...(request.topK !== undefined ? { topK: request.topK } : {}),
        },
        signal,
      );
      const [collection, stats] = await Promise.all([
        collections.get(search.collectionId),
        collections.getIndexStats(search.collectionId),
      ]);

      // Exactly what chat does: retrieval with `minScore`, then the prompt builder.
      const chatResults = applyMinScore(search.results, minScore);
      const prompt = buildPrompt({
        question: search.query,
        results: chatResults,
        contextCharBudget: chat.contextCharBudget,
      });
      const included = new Set(prompt.includedSources.map(({ result }) => result.chunkId));

      const results = search.results.map((result) => ({
        ...result,
        includedInChatContext: included.has(result.chunkId),
        belowMinScore: minScore !== null && result.score < minScore,
        embeddingHeader: embeddingHeader(result),
      }));
      const belowMinScoreCount = search.results.length - chatResults.length;
      const emptyReason: RetrievalEmptyReason | undefined =
        search.emptyReason ??
        (chatResults.length === 0 && search.results.length > 0 ? 'below_min_score' : undefined);

      const chatContext = {
        charBudget: chat.contextCharBudget,
        usedChars: prompt.contextChars,
        includedCount: prompt.includedSources.length,
        omittedByBudgetCount: prompt.omittedCount,
        belowMinScoreCount,
      };
      const collectionModel = {
        provider: collection.embeddingProvider,
        model: collection.embeddingModel,
        dimensions: collection.embeddingDimensions,
      };
      const providerModel = search.embedding;
      const wouldCallModel = prompt.includedSources.length > 0;

      return {
        collectionId: search.collectionId,
        query: search.query,
        results,
        ...(emptyReason ? { emptyReason } : {}),
        stats,
        embedding: {
          collection: collectionModel,
          provider: providerModel,
          matches:
            collectionModel.provider === providerModel.provider &&
            collectionModel.model === providerModel.model &&
            collectionModel.dimensions === providerModel.dimensions,
        },
        search: {
          metric: 'cosine',
          operator: DISTANCE_OPERATOR,
          iterativeScan: ITERATIVE_SCAN_MODE,
          efSearch: efSearchFor(search.topK),
          topK: search.topK,
          minScore,
        },
        chatContext,
        warnings: collectWarnings({
          emptyReason,
          stats,
          chatContext,
          minScore,
          queryChars: search.query.length,
          maxQuestionChars: chat.maxQuestionChars,
        }),
        timings: search.timings,
        ...(request.includePrompt
          ? {
              prompt: {
                messages: prompt.messages.map(({ role, content }) => ({ role, content })),
                wouldCallModel,
                ...(wouldCallModel ? {} : { noSourcesAnswer: NO_SOURCES_ANSWER }),
                chatModel,
              },
            }
          : {}),
      };
    },
  };
}

function validateMinScore(value: number | undefined): number | null {
  const minScore = value ?? null;
  if (
    minScore !== null &&
    (!Number.isFinite(minScore) || minScore < MIN_SCORE_LOWER || minScore > MIN_SCORE_UPPER)
  ) {
    throw badRequest('VALIDATION_ERROR', 'minScore must be a number between -1 and 1', [
      { location: 'body/minScore', message: 'must be a number between -1 and 1' },
    ]);
  }
  return minScore;
}

/** Human-readable problems, most important first. Messages never contain document text. */
export function collectWarnings({
  emptyReason,
  stats,
  chatContext,
  minScore,
  queryChars,
  maxQuestionChars,
}: {
  emptyReason: RetrievalEmptyReason | undefined;
  stats: PlaygroundCollectionStats;
  chatContext: PlaygroundSearchResponse['chatContext'];
  minScore: number | null;
  queryChars: number;
  maxQuestionChars: number;
}): PlaygroundWarning[] {
  const warnings: PlaygroundWarning[] = [];
  const add = (code: PlaygroundWarning['code'], message: string) =>
    warnings.push({ code, message });

  if (emptyReason === 'collection_empty') {
    add('COLLECTION_EMPTY', 'The knowledge base has no documents. Upload documents first.');
  } else if (emptyReason === 'no_indexed_chunks') {
    add(
      'NO_INDEXED_CHUNKS',
      'No chunk can be searched yet: no document is ready, or no chunk has an embedding.',
    );
  } else if (emptyReason === 'below_min_score') {
    add(
      'ALL_BELOW_MIN_SCORE',
      `No result reaches minScore ${String(minScore)}, so chat would answer without sources.`,
    );
  }

  const indexing = stats.documentsByStatus.pending + stats.documentsByStatus.processing;
  if (indexing > 0) {
    add(
      'DOCUMENTS_NOT_READY',
      `${count(indexing, 'document')} ${indexing === 1 ? 'is' : 'are'} still being indexed; their chunks are not searchable yet.`,
    );
  }
  if (stats.documentsByStatus.failed > 0) {
    add(
      'DOCUMENTS_FAILED',
      `${count(stats.documentsByStatus.failed, 'document')} failed to index; their chunks cannot be found. Reindex them in the knowledge base.`,
    );
  }
  if (stats.chunksWithoutEmbedding > 0) {
    add(
      'CHUNKS_WITHOUT_EMBEDDING',
      `${count(stats.chunksWithoutEmbedding, 'chunk')} without an embedding cannot be found by the search.`,
    );
  }
  if (
    chatContext.includedCount === 0 &&
    chatContext.omittedByBudgetCount > 0 &&
    emptyReason === undefined
  ) {
    add(
      'CONTEXT_BUDGET_TOO_SMALL',
      `Not even the best result fits into CHAT_CONTEXT_CHAR_BUDGET (${chatContext.charBudget} characters), so chat would answer without sources.`,
    );
  }
  if (queryChars > maxQuestionChars) {
    add(
      'QUERY_TOO_LONG_FOR_CHAT',
      `The query has ${queryChars} characters; chat accepts questions up to ${maxQuestionChars} characters (MAX_QUESTION_CHARS).`,
    );
  }
  return warnings;
}

function count(value: number, singular: string): string {
  return `${value} ${singular}${value === 1 ? '' : 's'}`;
}
