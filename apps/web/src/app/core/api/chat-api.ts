import { Injectable, InjectionToken, inject } from '@angular/core';
import type { ChatRequest, ChatStreamEvent, ChatStreamEventName } from '@raglab/shared';
import { ApiRequestError } from './api-error';
import { API_PATHS } from './api-paths';
import { type FetchFn, streamSse } from './sse-client';

/**
 * `fetch` used for streaming requests. `HttpClient` is not used here: the app runs it on XHR
 * (upload progress, 009), and neither backend exposes the body as a `ReadableStream`.
 */
export const FETCH = new InjectionToken<FetchFn>('FETCH', {
  providedIn: 'root',
  factory: () => (input, init) => fetch(input, init),
});

/**
 * The API sends a heartbeat comment every 15 s (`SSE_HEARTBEAT_MS`); three missed heartbeats mean
 * the connection is gone even if it was not closed (the dev-server proxy keeps it open when the
 * API dies).
 */
export const CHAT_STREAM_IDLE_TIMEOUT_MS = 45_000;

export const INVALID_STREAM_MESSAGE = 'The server sent an answer the app cannot read.';

const EVENT_NAMES: ReadonlySet<string> = new Set<ChatStreamEventName>([
  'sources',
  'token',
  'done',
  'error',
]);

/** Client for `POST /api/chat` (Server-Sent Events). */
@Injectable({ providedIn: 'root' })
export class ChatApi {
  private readonly fetchFn = inject(FETCH);

  /**
   * Yields the typed events of one answer: `sources` → `token`* → `done` | `error`.
   * Errors before the stream are thrown as `ApiRequestError` (`400`, `404`, `409`, `502`, `503`,
   * `0`/`NETWORK_ERROR`); a broken connection as `0`/`STREAM_INTERRUPTED`; an unreadable event as
   * `0`/`INVALID_STREAM`. Aborting `signal` throws an `AbortError` and closes the connection.
   * Unknown event names are ignored (forward compatibility).
   */
  async *streamChat(
    request: ChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamEvent, void, undefined> {
    for await (const message of streamSse(API_PATHS.chat, request, {
      signal,
      fetch: this.fetchFn,
      idleTimeoutMs: CHAT_STREAM_IDLE_TIMEOUT_MS,
    })) {
      if (!EVENT_NAMES.has(message.event)) {
        continue;
      }
      let data: unknown;
      try {
        data = JSON.parse(message.data);
      } catch {
        throw new ApiRequestError(0, 'INVALID_STREAM', INVALID_STREAM_MESSAGE);
      }
      if (typeof data !== 'object' || data === null) {
        throw new ApiRequestError(0, 'INVALID_STREAM', INVALID_STREAM_MESSAGE);
      }
      // The API is typed by the shared contract; only the envelope is checked here.
      yield { event: message.event, data } as ChatStreamEvent;
    }
  }
}
