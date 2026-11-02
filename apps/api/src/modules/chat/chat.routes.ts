import type { OutgoingHttpHeaders } from 'node:http';
import type { FastifyPluginAsync } from 'fastify';
import type { ChatDoneEvent, ChatRequest } from '@raglab/shared';
import { MAX_TOP_K } from '../../config/env.js';
import { AppError, errorResponseSchema, loggableError } from '../../http/errors.js';
import { ChatProviderError } from './chat-provider.js';
import type { ChatService } from './chat.service.js';
import { createSseWriter, SSE_HEARTBEAT_MS } from './sse.js';

export interface ChatRoutesOptions {
  chat: ChatService;
  /** `MAX_QUESTION_CHARS` (the service checks the trimmed length again). */
  maxQuestionChars: number;
  /** `RETRIEVAL_TOP_K`, shown in the OpenAPI description. */
  defaultTopK: number;
  /** Interval of SSE heartbeat comments; `0` disables them (tests). */
  heartbeatMs?: number;
  /** Open streams; `buildApp` aborts them before the server closes. */
  streams: ActiveStreams;
  /** Chat requests processed at the same time (`MAX_CONCURRENT_CHATS`); more → `429`. */
  maxConcurrentChats?: number;
}

/** `Retry-After` (seconds) when `MAX_CONCURRENT_CHATS` is reached. */
export const CONCURRENT_CHATS_RETRY_AFTER_SECONDS = 5;

/**
 * Abort controllers of open chat streams. Owned by `buildApp`, which aborts them in its
 * `preClose` hook – otherwise shutdown would wait until every answer is complete.
 */
export class ActiveStreams {
  private readonly controllers = new Set<AbortController>();

  add(controller: AbortController): void {
    this.controllers.add(controller);
  }

  delete(controller: AbortController): void {
    this.controllers.delete(controller);
  }

  get size(): number {
    return this.controllers.size;
  }

  abortAll(reason: Error): void {
    for (const controller of this.controllers) {
      controller.abort(reason);
    }
  }
}

const STREAM_DESCRIPTION = [
  'Server-Sent Events (`text/event-stream`), in this order:',
  '`event: sources` `{ sources: ChatSource[] }` (always first; `n` is the citation number),',
  '`event: token` `{ text }` (zero or more),',
  'then either `event: done` `{ answerStatus, citedSources, unknownCitations, model, timings }`',
  'or `event: error` `{ code, message }`; the stream ends after `done` or `error`.',
  'Types: `ChatStreamEvent` in `packages/shared/src/chat.ts`.',
].join(' ');

export const chatRoutes: FastifyPluginAsync<ChatRoutesOptions> = async (
  app,
  {
    chat,
    maxQuestionChars,
    defaultTopK,
    heartbeatMs = SSE_HEARTBEAT_MS,
    streams: active,
    maxConcurrentChats = Number.POSITIVE_INFINITY,
  },
) => {
  app.post<{ Body: ChatRequest }>(
    '/chat',
    {
      schema: {
        tags: ['chat'],
        summary: 'Grounded answer with sources, streamed as Server-Sent Events',
        description: [
          'Retrieves the `topK` best chunks of the collection (same retrieval as',
          '`POST /api/retrieval/search`), sends them to the chat model as numbered, delimited',
          'sources and streams the answer. Citations `[n]` refer to the `sources` event;',
          '`done.unknownCitations` lists numbers without a source. Without usable sources the model',
          'is not called: one fixed `token` and `done` with `answerStatus: "no_sources"`.',
          'Errors before the stream starts (validation, unknown collection, embedding model',
          'mismatch, embedding provider failures) are normal JSON error responses; chat provider',
          'failures arrive as an `error` event. Document content can contain instructions aimed at',
          'the model – the system prompt tells it to ignore them, but this is no complete',
          'protection against prompt injection: check answers against the sources.',
          'At most MAX_CONCURRENT_CHATS requests are processed at the same time; more →',
          '`429 TOO_MANY_CONCURRENT_CHATS` with `Retry-After`.',
        ].join(' '),
        body: {
          type: 'object',
          required: ['collectionId', 'question'],
          additionalProperties: false,
          properties: {
            collectionId: { type: 'string', format: 'uuid' },
            question: {
              type: 'string',
              minLength: 1,
              maxLength: maxQuestionChars,
              description: `Trimmed; 1..${maxQuestionChars} characters (MAX_QUESTION_CHARS)`,
            },
            topK: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_TOP_K,
              description: `Chunks to retrieve; defaults to RETRIEVAL_TOP_K (${defaultTopK})`,
            },
            minScore: {
              type: 'number',
              minimum: -1,
              maximum: 1,
              description: 'Ignore retrieved chunks with `score < minScore`',
            },
          },
        },
        response: {
          200: {
            description: STREAM_DESCRIPTION,
            content: { 'text/event-stream': { schema: { type: 'string' } } },
          },
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          429: errorResponseSchema,
          502: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // Each chat holds a model slot and a long-lived connection; refuse instead of queueing.
      if (active.size >= maxConcurrentChats) {
        void reply.header('retry-after', String(CONCURRENT_CHATS_RETRY_AFTER_SECONDS));
        throw new AppError(
          429,
          'TOO_MANY_CONCURRENT_CHATS',
          `Too many chat requests at the same time (at most ${maxConcurrentChats}). Try again in a few seconds.`,
          { maxConcurrentChats, retryAfterSeconds: CONCURRENT_CHATS_RETRY_AFTER_SECONDS },
        );
      }
      const controller = new AbortController();
      // `reply.raw` (not `request.raw`): the request emits `close` as soon as its body has been
      // read, the response only when the connection closes or the response has ended.
      reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) {
          controller.abort(new Error('client closed the request'));
        }
      });
      active.add(controller);
      try {
        // Validation, 404, model mismatch and embedding failures are thrown here and answered
        // as JSON by the central error handler – the stream has not started yet.
        const prepared = await chat.prepare(request.body, controller.signal);
        if (controller.signal.aborted) {
          // The client left while sources were retrieved – nobody to stream to.
          reply.hijack();
          reply.raw.destroy();
          return reply;
        }

        // From here on the response is written by hand. Headers set by hooks (CORS) are copied,
        // because `hijack()` bypasses Fastify's reply pipeline.
        reply.hijack();
        reply.raw.writeHead(200, {
          ...pendingHeaders(reply.getHeaders()),
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          // One stream per connection: the socket closes with the stream, so shutdown does not
          // wait for idle keep-alive connections of streaming clients.
          connection: 'close',
          'x-accel-buffering': 'no',
        });
        const sse = createSseWriter(reply.raw, { heartbeatMs });
        let done: ChatDoneEvent | undefined;
        let errorCode: string | undefined;
        try {
          await sse.send('sources', { sources: prepared.sources });
          const events = prepared.answer({
            signal: controller.signal,
            onError: (error) => {
              if (error instanceof ChatProviderError) {
                request.log.warn(
                  { providerCode: error.code, status: error.details.status },
                  `chat provider failed: ${error.message}`,
                );
              } else {
                request.log.error({ err: loggableError(error) }, 'chat answer failed');
              }
            },
          });
          for await (const event of events) {
            if (event.event === 'done') {
              done = event.data;
            } else if (event.event === 'error') {
              errorCode = event.data.code;
            }
            await sse.send(event.event, event.data);
          }
        } catch (error) {
          // Unexpected failure after the stream started: report it in-band, never crash.
          request.log.error({ err: loggableError(error) }, 'chat stream failed');
          errorCode = 'INTERNAL_ERROR';
          await sse.send('error', {
            code: 'INTERNAL_ERROR',
            message: 'The answer could not be generated. See the server log for details.',
          });
        } finally {
          sse.close();
        }
        // Content-free summary: never the question, sources or answer text.
        request.log.info(
          {
            ...prepared.summary,
            answerStatus: done?.answerStatus,
            citedSources: done?.citedSources.length,
            unknownCitations: done?.unknownCitations.length,
            timings: done?.timings,
            errorCode,
            aborted: controller.signal.aborted,
          },
          'chat answer',
        );
        return reply;
      } finally {
        active.delete(controller);
      }
    },
  );
};

/** Headers already set on the Fastify reply (e.g. by CORS hooks), without empty values. */
function pendingHeaders(headers: Record<string, unknown>): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string' || typeof value === 'number' || Array.isArray(value)) {
      result[name] = value as string | number | string[];
    }
  }
  return result;
}
