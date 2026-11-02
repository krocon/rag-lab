import {
  ApiRequestError,
  GENERIC_ERROR_MESSAGE,
  NETWORK_ERROR_MESSAGE,
  isApiErrorResponse,
} from './api-error';

/** One dispatched Server-Sent Event: the `event:` name (default `message`) and its `data:`. */
export interface SseMessage {
  event: string;
  data: string;
}

export interface SseParseResult {
  /** Complete events in the order they arrived. */
  events: SseMessage[];
  /** Unparsed rest (an incomplete frame); pass it as `pending` with the next chunk. */
  rest: string;
}

/** Message when the connection breaks after the response started (status `0`). */
export const STREAM_INTERRUPTED_MESSAGE =
  'The connection was interrupted before the answer was complete.';

/**
 * Parses decoded SSE text incrementally – a pure function, so frames split across network chunks
 * can be tested without a stream. `pending` is the `rest` of the previous call.
 *
 * Follows the SSE format of the HTML standard as far as this API needs it: lines end with LF, CRLF
 * or CR; a blank line dispatches the event; `event:` sets the name; several `data:` lines are joined
 * with `\n`; one space after the colon is removed; lines starting with `:` are comments
 * (heartbeats); `id:`/`retry:` and unknown fields are ignored; frames without `data` are not
 * dispatched. An incomplete last frame stays in `rest` (and is dropped at the end of the stream,
 * as the standard requires). `final` marks the end of the stream: a trailing CR is a line end then.
 */
export function parseSseChunk(pending: string, chunk: string, final = false): SseParseResult {
  let text = pending + chunk;
  // A trailing CR may be the first half of a CRLF split across chunks: decide with the next chunk.
  let held = '';
  if (!final && text.endsWith('\r')) {
    held = '\r';
    text = text.slice(0, -1);
  }
  text = text.replace(/\r\n?/g, '\n');

  const events: SseMessage[] = [];
  let start = 0;
  for (let end = text.indexOf('\n\n', start); end !== -1; end = text.indexOf('\n\n', start)) {
    const message = parseFrame(text.slice(start, end));
    if (message) {
      events.push(message);
    }
    start = end + 2;
  }
  return { events, rest: text.slice(start) + held };
}

function parseFrame(frame: string): SseMessage | undefined {
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line === '' || line.startsWith(':')) {
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    if (field === 'event') {
      event = value || 'message';
    } else if (field === 'data') {
      data.push(value);
    }
  }
  return data.length > 0 ? { event, data: data.join('\n') } : undefined;
}

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export interface StreamSseOptions {
  signal?: AbortSignal;
  /** Replaceable for tests; defaults to the global `fetch`. */
  fetch?: FetchFn;
  /**
   * Once the response has started: give up (`STREAM_INTERRUPTED`) when no bytes – events or
   * heartbeat comments – arrive for this long. Detects connections that died without closing
   * (e.g. behind a proxy when the server crashed). Default: no limit.
   */
  idleTimeoutMs?: number;
}

/**
 * `POST`s `body` as JSON and yields the Server-Sent Events of the response (`EventSource` cannot
 * send a POST body, so this reads the `fetch` body stream).
 *
 * - Non-2xx before the stream: throws `ApiRequestError` with the API's `{ error }` body
 *   (generic message if there is none); unreachable API: status `0`, `NETWORK_ERROR`.
 * - Connection lost while reading: `ApiRequestError` `0`/`STREAM_INTERRUPTED`.
 * - `signal` aborted: rethrows the `AbortError` (`DOMException`), never wrapped.
 * - Ending the iteration early (`break`, `return`) cancels the response body, which closes the
 *   connection – the server then stops generating.
 */
export async function* streamSse(
  url: string,
  body: unknown,
  {
    signal,
    fetch: fetchFn = (input, init) => fetch(input, init),
    idleTimeoutMs,
  }: StreamSseOptions = {},
): AsyncGenerator<SseMessage, void, undefined> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal,
    });
  } catch (error) {
    throw (
      rethrowAbort(error, signal) ?? new ApiRequestError(0, 'NETWORK_ERROR', NETWORK_ERROR_MESSAGE)
    );
  }

  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream') || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new ApiRequestError(response.status, 'UNEXPECTED_RESPONSE', GENERIC_ERROR_MESSAGE);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let rest = '';
  let finished = false;
  try {
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await withIdleTimeout(reader.read(), idleTimeoutMs);
      } catch (error) {
        throw (
          rethrowAbort(error, signal) ??
          new ApiRequestError(0, 'STREAM_INTERRUPTED', STREAM_INTERRUPTED_MESSAGE)
        );
      }
      if (result.done) {
        finished = true;
        const last = parseSseChunk(rest, decoder.decode(), true);
        yield* last.events;
        return;
      }
      const parsed = parseSseChunk(rest, decoder.decode(result.value, { stream: true }));
      rest = parsed.rest;
      yield* parsed.events;
    }
  } finally {
    if (!finished) {
      // Early exit or error: release the connection instead of draining it.
      await reader.cancel().catch(() => undefined);
    }
  }
}

/** Rejects with `STREAM_INTERRUPTED` if `read` does not settle within `timeoutMs`. */
function withIdleTimeout<T>(read: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined) {
    return read;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ApiRequestError(0, 'STREAM_INTERRUPTED', STREAM_INTERRUPTED_MESSAGE)),
      timeoutMs,
    );
  });
  return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
}

/** The abort error itself when `signal` caused the failure (callers distinguish cancel). */
function rethrowAbort(error: unknown, signal: AbortSignal | undefined): unknown {
  if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
    return error instanceof DOMException && error.name === 'AbortError'
      ? error
      : new DOMException('The request was aborted.', 'AbortError');
  }
  return undefined;
}

async function errorFromResponse(response: Response): Promise<ApiRequestError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (isApiErrorResponse(body)) {
    const { code, message, details } = body.error;
    return new ApiRequestError(response.status, code, message, details);
  }
  if (response.status === 502 || response.status === 504) {
    // A proxy in front of the API (dev server, nginx) answered: the API itself is down.
    return new ApiRequestError(response.status, 'NETWORK_ERROR', NETWORK_ERROR_MESSAGE);
  }
  return new ApiRequestError(response.status, 'UNKNOWN_ERROR', GENERIC_ERROR_MESSAGE);
}

/** True for the `AbortError` that `streamSse` rethrows after its signal aborted. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
