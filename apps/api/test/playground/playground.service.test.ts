import type {
  CollectionDto,
  RetrievalResult,
  RetrievalSearchRequest,
  RetrievalSearchResponse,
} from '@raglab/shared';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppError, conflict } from '../../src/http/errors.js';
import {
  buildGroundedPrompt,
  NO_SOURCES_ANSWER,
  SYSTEM_PROMPT,
  type GroundedPromptInput,
} from '../../src/modules/chat/prompt-builder.js';
import type { CollectionIndexStats } from '../../src/modules/collections/collections.repository.js';
import {
  collectWarnings,
  createPlaygroundService,
} from '../../src/modules/playground/playground.service.js';

const COLLECTION_ID = randomUUID();

function collection(overrides: Partial<CollectionDto> = {}): CollectionDto {
  return {
    id: COLLECTION_ID,
    name: 'Docs',
    description: null,
    embeddingProvider: 'ollama',
    embeddingModel: 'test-embedding-model',
    embeddingDimensions: 768,
    documentCount: 2,
    readyDocumentCount: 2,
    chunkCount: 4,
    createdAt: '2026-11-02T10:00:00.000Z',
    updatedAt: '2026-11-02T10:00:00.000Z',
    ...overrides,
  };
}

function result(rank: number, score: number, content = `chunk ${rank}`): RetrievalResult {
  return {
    rank,
    chunkId: randomUUID(),
    documentId: 'doc-a',
    filename: 'guide.md',
    chunkIndex: rank - 1,
    headingPath: ['Guide'],
    content,
    startOffset: 0,
    endOffset: content.length,
    distance: 1 - score,
    score,
  };
}

const STATS: CollectionIndexStats = {
  documentCount: 2,
  documentsByStatus: { pending: 0, processing: 0, ready: 2, failed: 0 },
  chunkCount: 4,
  searchableChunkCount: 4,
  chunksWithoutEmbedding: 0,
};

function searchResponse(
  results: RetrievalResult[],
  overrides: Partial<RetrievalSearchResponse> = {},
): RetrievalSearchResponse {
  return {
    collectionId: COLLECTION_ID,
    query: 'how?',
    topK: 8,
    minScore: null,
    embedding: { provider: 'ollama', model: 'test-embedding-model', dimensions: 768 },
    results,
    timings: { embeddingMs: 1.5, searchMs: 2.5 },
    ...overrides,
  };
}

interface Setup {
  response?: RetrievalSearchResponse | Error;
  stats?: CollectionIndexStats;
  buildPrompt?: typeof buildGroundedPrompt;
  contextCharBudget?: number;
  maxQuestionChars?: number;
}

function setup({
  response = searchResponse([]),
  stats = STATS,
  buildPrompt,
  contextCharBudget = 12_000,
  maxQuestionChars = 2000,
}: Setup = {}) {
  const searches: RetrievalSearchRequest[] = [];
  const promptInputs: GroundedPromptInput[] = [];
  const service = createPlaygroundService({
    retrieval: {
      search: async (request) => {
        searches.push(request);
        if (response instanceof Error) {
          throw response;
        }
        return response;
      },
    },
    collections: {
      get: async () => collection(),
      getIndexStats: async () => stats,
    },
    chat: { contextCharBudget, maxQuestionChars },
    chatModel: { provider: 'ollama', model: 'test-chat-model' },
    buildPrompt: (input) => {
      promptInputs.push(input);
      return (buildPrompt ?? buildGroundedPrompt)(input);
    },
  });
  return { service, searches, promptInputs };
}

/** Fake prompt builder that includes exactly the first `n` results. */
function includeFirst(n: number): typeof buildGroundedPrompt {
  return ({ results }) => ({
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'user' },
    ],
    includedSources: results.slice(0, n).map((item, index) => ({ n: index + 1, result: item })),
    contextChars: 100 * Math.min(n, results.length),
    omittedCount: Math.max(0, results.length - n),
  });
}

describe('playground service', () => {
  it('searches without minScore and flags results from the prompt builder selection', async () => {
    const results = [result(1, 0.9), result(2, 0.8), result(3, 0.6), result(4, 0.4)];
    const { service, searches, promptInputs } = setup({
      response: searchResponse(results),
      buildPrompt: includeFirst(2),
    });

    const response = await service.search({
      collectionId: COLLECTION_ID,
      query: '  how?  ',
      topK: 4,
      minScore: 0.5,
    });

    // The retrieval service gets everything except minScore (results below it stay visible).
    expect(searches).toEqual([{ collectionId: COLLECTION_ID, query: '  how?  ', topK: 4 }]);
    // The prompt builder sees exactly what chat would: results ≥ minScore, the trimmed query.
    expect(promptInputs).toHaveLength(1);
    expect(promptInputs[0]?.question).toBe('how?');
    expect(promptInputs[0]?.contextCharBudget).toBe(12_000);
    expect(promptInputs[0]?.results.map((item) => item.chunkId)).toEqual(
      results.slice(0, 3).map((item) => item.chunkId),
    );

    expect(
      response.results.map(({ rank, includedInChatContext, belowMinScore }) => ({
        rank,
        includedInChatContext,
        belowMinScore,
      })),
    ).toEqual([
      { rank: 1, includedInChatContext: true, belowMinScore: false },
      { rank: 2, includedInChatContext: true, belowMinScore: false },
      { rank: 3, includedInChatContext: false, belowMinScore: false },
      { rank: 4, includedInChatContext: false, belowMinScore: true },
    ]);
    // distance and score are passed through unchanged.
    expect(response.results[0]).toMatchObject({ score: 0.9, distance: results[0]?.distance });
    expect(response.chatContext).toEqual({
      charBudget: 12_000,
      usedChars: 200,
      includedCount: 2,
      omittedByBudgetCount: 1,
      belowMinScoreCount: 1,
    });
    expect(response).not.toHaveProperty('emptyReason');
    expect(response).not.toHaveProperty('prompt');
  });

  it('reports stats, embedding models, search settings and timings', async () => {
    const { service } = setup({
      response: searchResponse([result(1, 0.9)], { topK: 60 }),
    });

    const response = await service.search({ collectionId: COLLECTION_ID, query: 'q', topK: 60 });

    expect(response.stats).toEqual(STATS);
    expect(response.embedding).toEqual({
      collection: { provider: 'ollama', model: 'test-embedding-model', dimensions: 768 },
      provider: { provider: 'ollama', model: 'test-embedding-model', dimensions: 768 },
      matches: true,
    });
    expect(response.search).toEqual({
      metric: 'cosine',
      operator: '<=>',
      iterativeScan: 'relaxed_order',
      efSearch: 60,
      topK: 60,
      minScore: null,
    });
    expect(response.timings).toEqual({ embeddingMs: 1.5, searchMs: 2.5 });
    expect(response.warnings).toEqual([]);
  });

  it('uses ef_search 40 for small topK', async () => {
    const { service } = setup({ response: searchResponse([], { topK: 5 }) });
    const response = await service.search({ collectionId: COLLECTION_ID, query: 'q', topK: 5 });
    expect(response.search.efSearch).toBe(40);
  });

  it('returns the prompt chat would send only on request, without calling a model', async () => {
    const results = [result(1, 0.9, 'Run pnpm install.')];
    const { service } = setup({ response: searchResponse(results) });

    const response = await service.search({
      collectionId: COLLECTION_ID,
      query: 'how?',
      includePrompt: true,
    });

    const expected = buildGroundedPrompt({ question: 'how?', results, contextCharBudget: 12_000 });
    expect(response.prompt).toEqual({
      messages: expected.messages,
      wouldCallModel: true,
      chatModel: { provider: 'ollama', model: 'test-chat-model' },
    });
    expect(response.prompt?.messages[0]?.content).toBe(SYSTEM_PROMPT);
    expect(response.prompt?.messages[1]?.content).toContain('Run pnpm install.');
  });

  it('shows the fixed answer when chat would not call the model', async () => {
    const { service } = setup({
      response: searchResponse([], { emptyReason: 'collection_empty' }),
    });

    const response = await service.search({
      collectionId: COLLECTION_ID,
      query: 'how?',
      includePrompt: true,
    });

    expect(response.emptyReason).toBe('collection_empty');
    expect(response.prompt).toMatchObject({
      wouldCallModel: false,
      noSourcesAnswer: NO_SOURCES_ANSWER,
    });
    expect(response.warnings.map((warning) => warning.code)).toEqual(['COLLECTION_EMPTY']);
  });

  it('reports below_min_score when results exist but none reaches minScore', async () => {
    const { service } = setup({ response: searchResponse([result(1, 0.3), result(2, 0.2)]) });

    const response = await service.search({
      collectionId: COLLECTION_ID,
      query: 'q',
      minScore: 0.5,
    });

    expect(response.results).toHaveLength(2);
    expect(response.results.every((item) => item.belowMinScore)).toBe(true);
    expect(response.results.some((item) => item.includedInChatContext)).toBe(false);
    expect(response.emptyReason).toBe('below_min_score');
    expect(response.search.minScore).toBe(0.5);
    expect(response.warnings.map((warning) => warning.code)).toEqual(['ALL_BELOW_MIN_SCORE']);
  });

  it('warns when not even the best result fits into the context budget', async () => {
    const { service } = setup({
      response: searchResponse([result(1, 0.9, 'x'.repeat(2000))]),
      contextCharBudget: 1000,
    });

    const response = await service.search({ collectionId: COLLECTION_ID, query: 'q' });

    expect(response.results[0]?.includedInChatContext).toBe(false);
    expect(response.results[0]?.belowMinScore).toBe(false);
    expect(response.chatContext).toMatchObject({ includedCount: 0, omittedByBudgetCount: 1 });
    expect(response.warnings.map((warning) => warning.code)).toEqual(['CONTEXT_BUDGET_TOO_SMALL']);
  });

  it('warns about documents and chunks that cannot be found and too long questions', async () => {
    const { service } = setup({
      response: searchResponse([result(1, 0.9)], { query: 'x'.repeat(30) }),
      stats: {
        documentCount: 5,
        documentsByStatus: { pending: 1, processing: 1, ready: 2, failed: 1 },
        chunkCount: 10,
        searchableChunkCount: 6,
        chunksWithoutEmbedding: 1,
      },
      maxQuestionChars: 20,
    });

    const response = await service.search({ collectionId: COLLECTION_ID, query: 'x'.repeat(30) });

    expect(response.warnings).toEqual([
      {
        code: 'DOCUMENTS_NOT_READY',
        message: '2 documents are still being indexed; their chunks are not searchable yet.',
      },
      {
        code: 'DOCUMENTS_FAILED',
        message:
          '1 document failed to index; their chunks cannot be found. Reindex them in the knowledge base.',
      },
      {
        code: 'CHUNKS_WITHOUT_EMBEDDING',
        message: '1 chunk without an embedding cannot be found by the search.',
      },
      {
        code: 'QUERY_TOO_LONG_FOR_CHAT',
        message:
          'The query has 30 characters; chat accepts questions up to 20 characters (MAX_QUESTION_CHARS).',
      },
    ]);
  });

  it('reports no_indexed_chunks from retrieval as a warning', () => {
    expect(
      collectWarnings({
        emptyReason: 'no_indexed_chunks',
        stats: STATS,
        chatContext: {
          charBudget: 1000,
          usedChars: 0,
          includedCount: 0,
          omittedByBudgetCount: 0,
          belowMinScoreCount: 0,
        },
        minScore: null,
        queryChars: 1,
        maxQuestionChars: 10,
      }).map((warning) => warning.code),
    ).toEqual(['NO_INDEXED_CHUNKS']);
  });

  it.each([1.5, -2, Number.NaN])('rejects minScore %s with 400 before searching', async (value) => {
    const { service, searches } = setup();

    await expect(
      service.search({ collectionId: COLLECTION_ID, query: 'q', minScore: value }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect(searches).toEqual([]);
  });

  it('passes retrieval errors through unchanged (e.g. 409 EMBEDDING_MODEL_MISMATCH)', async () => {
    const mismatch = conflict('EMBEDDING_MODEL_MISMATCH', 'Model changed.', { a: 1 });
    const { service } = setup({ response: mismatch });

    const error = await service
      .search({ collectionId: COLLECTION_ID, query: 'q' })
      .catch((caught: unknown) => caught);

    expect(error).toBe(mismatch);
    expect(error).toBeInstanceOf(AppError);
  });
});
