import type { ChatStreamEvent, RetrievalResult, RetrievalSearchResponse } from '@raglab/shared';
import { describe, expect, it } from 'vitest';
import { ChatProviderError } from '../../src/modules/chat/chat-provider.js';
import { createChatService, toErrorEvent } from '../../src/modules/chat/chat.service.js';
import { NO_SOURCES_ANSWER } from '../../src/modules/chat/prompt-builder.js';
import type { RetrievalService } from '../../src/modules/retrieval/retrieval.service.js';
import { createFakeChatProvider } from '../fakes/fake-chat-provider.js';

const COLLECTION = '0195f2a0-0000-7000-8000-000000000001';

function result(rank: number, content: string): RetrievalResult {
  return {
    rank,
    chunkId: `0195f2a0-0000-7000-8000-00000000010${rank}`,
    documentId: '0195f2a0-0000-7000-8000-000000000200',
    filename: 'guide.md',
    path: null,
    language: 'markdown',
    startLine: null,
    endLine: null,
    symbol: null,
    sourceUrl: null,
    chunkIndex: rank - 1,
    headingPath: [],
    content,
    startOffset: 0,
    endOffset: content.length,
    distance: rank / 10,
    score: 1 - rank / 10,
  };
}

/** Retrieval stub that records requests and returns fixed results. */
function retrievalReturning(results: RetrievalResult[]) {
  const requests: unknown[] = [];
  const service: RetrievalService = {
    async search(request) {
      requests.push(request);
      const response: RetrievalSearchResponse = {
        collectionId: request.collectionId,
        query: request.query.trim(),
        topK: request.topK ?? 8,
        minScore: request.minScore ?? null,
        embedding: { provider: 'ollama', model: 'm', dimensions: 768 },
        results,
        timings: { embeddingMs: 1.5, searchMs: 2.5 },
      };
      return results.length > 0 ? response : { ...response, emptyReason: 'collection_empty' };
    },
  };
  return { service, requests };
}

async function collect(events: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const all: ChatStreamEvent[] = [];
  for await (const event of events) {
    all.push(event);
  }
  return all;
}

const config = { contextCharBudget: 2000, maxQuestionChars: 50 };

describe('ChatService', () => {
  it('passes the trimmed question, topK and minScore to retrieval', async () => {
    const retrieval = retrievalReturning([]);
    const chat = createChatService({
      retrieval: retrieval.service,
      provider: createFakeChatProvider(),
      config,
    });

    await chat.prepare({ collectionId: COLLECTION, question: '  What?  ', topK: 3, minScore: 0.5 });

    expect(retrieval.requests).toEqual([
      { collectionId: COLLECTION, query: 'What?', topK: 3, minScore: 0.5 },
    ]);
  });

  it.each([
    ['blank', '   '],
    ['too long', 'x'.repeat(51)],
  ])('rejects a %s question before retrieval', async (_name, question) => {
    const retrieval = retrievalReturning([]);
    const chat = createChatService({
      retrieval: retrieval.service,
      provider: createFakeChatProvider(),
      config,
    });

    await expect(chat.prepare({ collectionId: COLLECTION, question })).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      details: [expect.objectContaining({ location: 'body/question' }) as unknown],
    });
    expect(retrieval.requests).toEqual([]);
  });

  it('answers no_sources without the model when the best source exceeds the budget', async () => {
    const provider = createFakeChatProvider({ forbidCalls: true });
    const chat = createChatService({
      retrieval: retrievalReturning([result(1, 'x'.repeat(3000))]).service,
      provider,
      config,
    });

    const prepared = await chat.prepare({ collectionId: COLLECTION, question: 'q' });
    const events = await collect(prepared.answer());

    expect(prepared.sources).toEqual([]);
    expect(prepared.summary).toMatchObject({ retrieved: 1, sources: 0, omitted: 1 });
    expect(events.map((event) => event.event)).toEqual(['token', 'done']);
    expect(events[0]).toEqual({ event: 'token', data: { text: NO_SOURCES_ANSWER } });
    expect(events[1]).toMatchObject({ data: { answerStatus: 'no_sources', model: null } });
  });

  it('maps sources 1..n in rank order and reports retrieval timings', async () => {
    const chat = createChatService({
      retrieval: retrievalReturning([result(1, 'one'), result(2, 'two')]).service,
      provider: createFakeChatProvider({ tokens: ['See [2]'] }),
      config,
    });

    const prepared = await chat.prepare({ collectionId: COLLECTION, question: 'q' });
    const events = await collect(prepared.answer());

    expect(prepared.sources.map((source) => [source.n, source.content])).toEqual([
      [1, 'one'],
      [2, 'two'],
    ]);
    const done = events.at(-1);
    expect(done).toMatchObject({
      event: 'done',
      data: {
        answerStatus: 'answered',
        citedSources: [2],
        timings: { embeddingMs: 1.5, searchMs: 2.5 },
      },
    });
  });

  it('ends quietly when the signal aborts while streaming', async () => {
    const provider = createFakeChatProvider({ tokens: ['a', 'b', 'c'], delayMs: 5 });
    const chat = createChatService({
      retrieval: retrievalReturning([result(1, 'one')]).service,
      provider,
      config,
    });
    const controller = new AbortController();
    const errors: unknown[] = [];

    const prepared = await chat.prepare({ collectionId: COLLECTION, question: 'q' });
    const events: ChatStreamEvent[] = [];
    for await (const event of prepared.answer({
      signal: controller.signal,
      onError: (error) => errors.push(error),
    })) {
      events.push(event);
      controller.abort(new Error('client closed the request'));
    }

    expect(events.map((event) => event.event)).toEqual(['token']);
    expect(errors).toEqual([]);
    expect(provider.calls[0]?.signal?.aborted).toBe(true);
  });
});

describe('toErrorEvent', () => {
  it.each([
    ['PROVIDER_UNREACHABLE', 'CHAT_PROVIDER_UNAVAILABLE'],
    ['PROVIDER_TIMEOUT', 'CHAT_PROVIDER_UNAVAILABLE'],
    ['MODEL_NOT_FOUND', 'CHAT_PROVIDER_ERROR'],
    ['PROVIDER_ERROR', 'CHAT_PROVIDER_ERROR'],
  ] as const)('maps %s to %s with the hint in the message', (providerCode, code) => {
    expect(
      toErrorEvent(new ChatProviderError(providerCode, 'Problem.', { hint: 'Fix it.' })),
    ).toEqual({ code, message: 'Problem. Fix it.' });
  });
});
