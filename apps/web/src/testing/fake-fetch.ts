import type { FetchFn } from '../app/core/api/sse-client';

/** One SSE frame as the API writes it (`apps/api/src/modules/chat/sse.ts`). */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A streamed `fetch` response the test writes to piece by piece. */
export interface FakeStream {
  push(text: string): void;
  /** Raw bytes, e.g. half of a multi-byte UTF-8 character. */
  pushBytes(bytes: Uint8Array): void;
  /** Ends the body normally. */
  close(): void;
  /** Breaks the body like a lost connection. */
  fail(): void;
  /** The client cancelled the body (break/abort). */
  readonly cancelled: boolean;
}

interface PendingRequest {
  url: string;
  init: RequestInit;
  resolve(response: Response): void;
  reject(error: unknown): void;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Scriptable `fetch` for streaming tests: requests stay pending until the test answers them.
 * Like the browser, an aborted signal rejects the request or errors the body with an `AbortError`.
 */
export class FakeFetch {
  readonly requests: PendingRequest[] = [];
  private next = 0;

  readonly fn: FetchFn = (url, init) =>
    new Promise<Response>((resolve, reject) => {
      if (init.signal?.aborted) {
        reject(abortError());
        return;
      }
      init.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      this.requests.push({ url, init, resolve, reject });
    });

  /** Parsed JSON body of request `index` (default: the latest). */
  body(index = this.requests.length - 1): unknown {
    const request = this.requests[index];
    return request ? JSON.parse(String(request.init.body)) : undefined;
  }

  /** Answers the next open request with an event stream. */
  respondStream(status = 200): FakeStream {
    const request = this.take();
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const state = { cancelled: false, closed: false };
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        state.cancelled = true;
      },
    });
    request.init.signal?.addEventListener(
      'abort',
      () => {
        if (!state.closed) {
          state.closed = true;
          controller.error(abortError());
        }
      },
      { once: true },
    );
    request.resolve(
      new Response(body, {
        status,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      }),
    );
    return {
      push: (text) => {
        if (!state.closed) {
          controller.enqueue(encoder.encode(text));
        }
      },
      pushBytes: (bytes) => {
        if (!state.closed) {
          controller.enqueue(bytes);
        }
      },
      close: () => {
        if (!state.closed) {
          state.closed = true;
          controller.close();
        }
      },
      fail: () => {
        if (!state.closed) {
          state.closed = true;
          controller.error(new TypeError('network error'));
        }
      },
      get cancelled() {
        return state.cancelled;
      },
    };
  }

  /** Answers the next open request with JSON (e.g. an API error before the stream). */
  respondJson(status: number, body: unknown): void {
    this.take().resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    );
  }

  /** Fails the next open request like an unreachable server. */
  failNetwork(): void {
    this.take().reject(new TypeError('Failed to fetch'));
  }

  private take(): PendingRequest {
    const request = this.requests[this.next];
    if (!request) {
      throw new Error('No open fetch request');
    }
    this.next += 1;
    return request;
  }
}

/** Lets promises and stream reads settle (real timers). */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
