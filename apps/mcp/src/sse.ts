/**
 * Incremental Server-Sent-Events parser for `POST /api/chat`.
 *
 * Deliberately a small own implementation: `packages/shared` is type-only and the web app's parser
 * (`apps/web/src/app/core/api/sse-client.ts`) belongs to the Angular app. Same rules as there
 * (HTML standard, as far as the API needs it): lines end with LF, CRLF or CR; a blank line
 * dispatches the event; `event:` sets the name (default `message`); several `data:` lines are
 * joined with `\n`; one space after the colon is removed; `:` lines are comments (heartbeats);
 * other fields are ignored; frames without data are not dispatched.
 */
export interface SseMessage {
  event: string;
  data: string;
}

export interface SseParseResult {
  events: SseMessage[];
  /** Incomplete rest; pass it as `pending` with the next chunk. */
  rest: string;
}

export function parseSseChunk(pending: string, chunk: string, final = false): SseParseResult {
  let text = pending + chunk;
  // A trailing CR may be the first half of a CRLF split across chunks: decide with the next one.
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

/** Yields the SSE messages of a response body; an incomplete last frame is dropped. */
export async function* readSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let rest = '';
  let finished = false;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        finished = true;
        yield* parseSseChunk(rest, decoder.decode(), true).events;
        return;
      }
      const parsed = parseSseChunk(rest, decoder.decode(result.value, { stream: true }));
      rest = parsed.rest;
      yield* parsed.events;
    }
  } finally {
    if (!finished) {
      // Early exit or error: close the connection, so the API stops generating.
      await reader.cancel().catch(() => undefined);
    }
  }
}
