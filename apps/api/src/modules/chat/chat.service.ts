import type {
  ChatDoneEvent,
  ChatErrorEvent,
  ChatRequest,
  ChatSource,
  ChatStreamEvent,
  RetrievalSearchRequest,
} from '@raglab/shared';
import type { AppConfig } from '../../config/env.js';
import { badRequest } from '../../http/errors.js';
import type { RetrievalService } from '../retrieval/retrieval.service.js';
import { ChatProviderError, type ChatProvider } from './chat-provider.js';
import { analyzeCitations } from './citations.js';
import { buildGroundedPrompt, NO_SOURCES_ANSWER, type GroundedPrompt } from './prompt-builder.js';

export interface ChatService {
  /**
   * Validates the request, retrieves sources (same retrieval service as the search endpoint and
   * the playground) and builds the prompt – everything that can fail with a normal HTTP error.
   * Throws `AppError`s: `400 VALIDATION_ERROR`, `404 COLLECTION_NOT_FOUND`,
   * `409 EMBEDDING_MODEL_MISMATCH`, `502/503` embedding provider errors (see RetrievalService).
   */
  prepare(request: ChatRequest, signal?: AbortSignal): Promise<PreparedChat>;
}

export interface PreparedChat {
  /** Sources for the `sources` event – exactly the ones in the prompt, numbered 1..n. */
  readonly sources: ChatSource[];
  /** Content-free facts for logs. */
  readonly summary: ChatSummary;
  /**
   * Streams `token`* followed by `done` or `error`. Never throws for provider failures (they
   * become an `error` event); when `signal` aborts, it ends without further events.
   * Without sources it answers with a fixed text and does not call the provider.
   */
  answer(options?: AnswerOptions): AsyncGenerator<ChatStreamEvent, void, undefined>;
}

export interface AnswerOptions {
  signal?: AbortSignal;
  /** Called with errors that end the stream (provider or unexpected), for logging. */
  onError?: (error: unknown) => void;
}

export interface ChatSummary {
  collectionId: string;
  questionChars: number;
  /** Results returned by retrieval. */
  retrieved: number;
  /** Sources in the prompt. */
  sources: number;
  /** Results left out by the context budget. */
  omitted: number;
  contextChars: number;
  emptyReason?: string;
}

export interface ChatServiceDependencies {
  retrieval: RetrievalService;
  provider: ChatProvider;
  config: Pick<AppConfig['chat'], 'contextCharBudget' | 'maxQuestionChars'>;
}

/** Provider failures that are temporary: retrying later may succeed. */
const UNAVAILABLE_PROVIDER_CODES = new Set(['PROVIDER_UNREACHABLE', 'PROVIDER_TIMEOUT']);

export function createChatService({
  retrieval,
  provider,
  config,
}: ChatServiceDependencies): ChatService {
  return {
    async prepare(request, signal) {
      const started = performance.now();
      const question = validateQuestion(request.question, config.maxQuestionChars);

      const searchRequest: RetrievalSearchRequest = {
        collectionId: request.collectionId,
        query: question,
        ...(request.topK !== undefined ? { topK: request.topK } : {}),
        ...(request.minScore !== undefined ? { minScore: request.minScore } : {}),
      };
      const search = await retrieval.search(searchRequest, signal);

      const prompt = buildGroundedPrompt({
        question: search.query,
        results: search.results,
        contextCharBudget: config.contextCharBudget,
      });
      const sources: ChatSource[] = prompt.includedSources.map(({ n, result }) => ({
        n,
        documentId: result.documentId,
        chunkId: result.chunkId,
        chunkIndex: result.chunkIndex,
        filename: result.filename,
        path: result.path,
        language: result.language,
        headingPath: result.headingPath,
        content: result.content,
        startLine: result.startLine,
        endLine: result.endLine,
        symbol: result.symbol,
        sourceUrl: result.sourceUrl,
        score: result.score,
        distance: result.distance,
      }));
      const summary: ChatSummary = {
        collectionId: search.collectionId,
        questionChars: search.query.length,
        retrieved: search.results.length,
        sources: sources.length,
        omitted: prompt.omittedCount,
        contextChars: prompt.contextChars,
        ...(search.emptyReason ? { emptyReason: search.emptyReason } : {}),
      };

      return {
        sources,
        summary,
        answer: (options) =>
          streamAnswer({
            provider,
            prompt,
            timings: search.timings,
            started,
            options: options ?? {},
          }),
      };
    },
  };
}

async function* streamAnswer({
  provider,
  prompt,
  timings,
  started,
  options: { signal, onError } = {},
}: {
  provider: ChatProvider;
  prompt: GroundedPrompt;
  timings: { embeddingMs: number; searchMs: number };
  started: number;
  options?: AnswerOptions;
}): AsyncGenerator<ChatStreamEvent, void, undefined> {
  const sourceCount = prompt.includedSources.length;
  const done = (
    answer: string,
    status: ChatDoneEvent['answerStatus'],
    generation: { firstTokenMs: number | null; generationMs: number },
  ): ChatStreamEvent => ({
    event: 'done',
    data: {
      answerStatus: status,
      ...analyzeCitations(answer, sourceCount),
      model: status === 'answered' ? provider.model : null,
      timings: { ...timings, ...generation, totalMs: elapsedSince(started) },
    },
  });

  // No sources: deterministic answer, the model is never asked without context.
  if (sourceCount === 0) {
    yield { event: 'token', data: { text: NO_SOURCES_ANSWER } };
    yield done('', 'no_sources', { firstTokenMs: null, generationMs: 0 });
    return;
  }

  const generationStart = performance.now();
  let firstTokenMs: number | null = null;
  let answer = '';
  try {
    for await (const text of provider.stream(prompt.messages, signal)) {
      if (signal?.aborted) {
        return;
      }
      firstTokenMs ??= elapsedSince(generationStart);
      answer += text;
      yield { event: 'token', data: { text } };
    }
  } catch (error) {
    if (signal?.aborted) {
      // The client is gone; nobody would receive an event.
      return;
    }
    onError?.(error);
    yield { event: 'error', data: toErrorEvent(error) };
    return;
  }
  if (signal?.aborted) {
    return;
  }
  yield done(answer, 'answered', { firstTokenMs, generationMs: elapsedSince(generationStart) });
}

/**
 * Chat provider failures as `error` events: unreachable or timed out →
 * `CHAT_PROVIDER_UNAVAILABLE`; model missing, invalid answer, other → `CHAT_PROVIDER_ERROR`;
 * anything else → `INTERNAL_ERROR` without details. Messages contain no prompt or document text.
 */
export function toErrorEvent(error: unknown): ChatErrorEvent {
  if (error instanceof ChatProviderError) {
    return {
      code: UNAVAILABLE_PROVIDER_CODES.has(error.code)
        ? 'CHAT_PROVIDER_UNAVAILABLE'
        : 'CHAT_PROVIDER_ERROR',
      message: error.userMessage,
    };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: 'The answer could not be generated. See the server log for details.',
  };
}

function validateQuestion(value: unknown, maxQuestionChars: number): string {
  const question = typeof value === 'string' ? value.trim() : '';
  if (question.length === 0) {
    throw badRequest('VALIDATION_ERROR', 'question must not be blank', [
      { location: 'body/question', message: 'must not be blank' },
    ]);
  }
  if (question.length > maxQuestionChars) {
    throw badRequest(
      'VALIDATION_ERROR',
      `question must not be longer than ${maxQuestionChars} characters`,
      [
        {
          location: 'body/question',
          message: `must NOT have more than ${maxQuestionChars} characters`,
        },
      ],
    );
  }
  return question;
}

/** Milliseconds since `start`, rounded to 0.1 ms. */
function elapsedSince(start: number): number {
  return Math.round((performance.now() - start) * 10) / 10;
}
