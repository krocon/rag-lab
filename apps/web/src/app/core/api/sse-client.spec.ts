import { FakeFetch, settle } from '../../../testing/fake-fetch';
import { ApiRequestError, NETWORK_ERROR_MESSAGE } from './api-error';
import { type SseMessage, isAbortError, parseSseChunk, streamSse } from './sse-client';

/** Feeds `chunks` one after another through the parser, like a stream. */
function parseAll(chunks: string[]): { events: SseMessage[]; rest: string } {
  const events: SseMessage[] = [];
  let rest = '';
  for (const chunk of chunks) {
    const result = parseSseChunk(rest, chunk);
    events.push(...result.events);
    rest = result.rest;
  }
  return { events, rest };
}

describe('parseSseChunk', () => {
  it('parses complete frames with event name and JSON data', () => {
    const { events, rest } = parseSseChunk(
      '',
      'event: sources\ndata: {"sources":[]}\n\nevent: token\ndata: {"text":"Hi"}\n\n',
    );
    expect(events).toEqual([
      { event: 'sources', data: '{"sources":[]}' },
      { event: 'token', data: '{"text":"Hi"}' },
    ]);
    expect(rest).toBe('');
  });

  it('keeps an incomplete frame as rest until its blank line arrives', () => {
    const first = parseSseChunk('', 'event: token\ndata: {"te');
    expect(first.events).toEqual([]);
    const second = parseSseChunk(first.rest, 'xt":"a"}\n');
    expect(second.events).toEqual([]);
    const third = parseSseChunk(second.rest, '\n');
    expect(third.events).toEqual([{ event: 'token', data: '{"text":"a"}' }]);
    expect(third.rest).toBe('');
  });

  it('handles frames split at every possible position', () => {
    const stream = 'event: token\ndata: {"text":"x"}\n\nevent: done\ndata: {}\n\n';
    for (let size = 1; size <= 7; size++) {
      const chunks = stream.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? [];
      expect(parseAll(chunks).events).toEqual([
        { event: 'token', data: '{"text":"x"}' },
        { event: 'done', data: '{}' },
      ]);
    }
  });

  it('joins multi-line data with line breaks', () => {
    const { events } = parseSseChunk('', 'data: first\ndata: second\ndata:\n\n');
    expect(events).toEqual([{ event: 'message', data: 'first\nsecond\n' }]);
  });

  it('ignores comments (heartbeats), id/retry and unknown fields', () => {
    const { events } = parseSseChunk(
      '',
      ': heartbeat\n\n: note\nid: 7\nretry: 1000\nfoo: bar\nevent: token\ndata: {"text":"a"}\n\n',
    );
    expect(events).toEqual([{ event: 'token', data: '{"text":"a"}' }]);
  });

  it('does not dispatch frames without data', () => {
    expect(parseSseChunk('', 'event: token\n\n').events).toEqual([]);
  });

  it('removes exactly one space after the colon', () => {
    expect(parseSseChunk('', 'data:a\n\ndata:  b\n\n').events).toEqual([
      { event: 'message', data: 'a' },
      { event: 'message', data: ' b' },
    ]);
  });

  it('accepts CRLF and CR line endings, also when a CRLF is split across chunks', () => {
    expect(parseSseChunk('', 'event: token\r\ndata: 1\r\n\r\n').events).toEqual([
      { event: 'token', data: '1' },
    ]);
    // A trailing CR waits for the next chunk (it could be half of a CRLF) unless the stream ended.
    const cr = parseSseChunk('', 'event: token\rdata: 2\r\r');
    expect(cr.events).toEqual([]);
    expect(parseSseChunk(cr.rest, 'x').events).toEqual([{ event: 'token', data: '2' }]);
    expect(parseSseChunk('', 'event: token\rdata: 2\r\r', true).events).toEqual([
      { event: 'token', data: '2' },
    ]);
    expect(parseAll(['event: token\r', '\ndata: 3\r', '\n\r', '\n']).events).toEqual([
      { event: 'token', data: '3' },
    ]);
  });

  it('keeps data containing colons and markup unchanged', () => {
    const { events } = parseSseChunk('', 'data: {"text":"<img src=x onerror=alert(1)> a:b"}\n\n');
    expect(events[0]?.data).toBe('{"text":"<img src=x onerror=alert(1)> a:b"}');
  });
});

describe('streamSse', () => {
  async function collect(iterable: AsyncIterable<SseMessage>): Promise<SseMessage[]> {
    const result: SseMessage[] = [];
    for await (const message of iterable) {
      result.push(message);
    }
    return result;
  }

  it('POSTs JSON and yields events across chunk boundaries, including split UTF-8', async () => {
    const fake = new FakeFetch();
    const promise = collect(streamSse('/api/chat', { q: 1 }, { fetch: fake.fn }));
    await settle();
    expect(fake.requests[0]?.url).toBe('/api/chat');
    expect(fake.requests[0]?.init.method).toBe('POST');
    expect(fake.body()).toEqual({ q: 1 });

    const stream = fake.respondStream();
    const bytes = new TextEncoder().encode('event: token\ndata: {"text":"Grüße"}\n\n');
    // Split inside the two-byte "ü".
    const cut = bytes.indexOf(0xc3) + 1;
    stream.push('event: sources\nda');
    stream.push('ta: {"sources":[]}\n\n');
    await settle();
    stream.pushBytes(bytes.slice(0, cut));
    await settle();
    stream.pushBytes(bytes.slice(cut));
    stream.close();

    await expect(promise).resolves.toEqual([
      { event: 'sources', data: '{"sources":[]}' },
      { event: 'token', data: '{"text":"Grüße"}' },
    ]);
  });

  it('throws the API error of a non-2xx response before the stream', async () => {
    const fake = new FakeFetch();
    const promise = collect(streamSse('/api/chat', {}, { fetch: fake.fn }));
    await settle();
    fake.respondJson(409, {
      error: { code: 'EMBEDDING_MODEL_MISMATCH', message: 'Model differs', details: { a: 1 } },
    });

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      status: 409,
      code: 'EMBEDDING_MODEL_MISMATCH',
      message: 'Model differs',
      details: { a: 1 },
    });
  });

  it('uses a generic message for error responses without the API format', async () => {
    const fake = new FakeFetch();
    const promise = collect(streamSse('/api/chat', {}, { fetch: fake.fn }));
    await settle();
    fake.requests[0]?.resolve(new Response('<html>Error</html>', { status: 500 }));

    await expect(promise).rejects.toMatchObject({ status: 500, code: 'UNKNOWN_ERROR' });
  });

  it('treats a bodyless 502/504 of a proxy as an unreachable API', async () => {
    const fake = new FakeFetch();
    const promise = collect(streamSse('/api/chat', {}, { fetch: fake.fn }));
    await settle();
    fake.requests[0]?.resolve(new Response('', { status: 502 }));

    await expect(promise).rejects.toMatchObject({
      status: 502,
      code: 'NETWORK_ERROR',
      message: NETWORK_ERROR_MESSAGE,
    });
  });

  it('reports an unreachable API as NETWORK_ERROR with status 0', async () => {
    const fake = new FakeFetch();
    const promise = collect(streamSse('/api/chat', {}, { fetch: fake.fn }));
    await settle();
    fake.failNetwork();

    await expect(promise).rejects.toMatchObject({
      status: 0,
      code: 'NETWORK_ERROR',
      message: NETWORK_ERROR_MESSAGE,
    });
  });

  it('rejects a 200 response that is not an event stream', async () => {
    const fake = new FakeFetch();
    const promise = collect(streamSse('/api/chat', {}, { fetch: fake.fn }));
    await settle();
    fake.respondJson(200, { ok: true });

    await expect(promise).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('reports a connection lost while reading as STREAM_INTERRUPTED', async () => {
    const fake = new FakeFetch();
    const received: SseMessage[] = [];
    const promise = (async () => {
      for await (const message of streamSse('/api/chat', {}, { fetch: fake.fn })) {
        received.push(message);
      }
    })();
    await settle();
    const stream = fake.respondStream();
    stream.push('event: token\ndata: {"text":"a"}\n\n');
    await settle();
    stream.fail();

    await expect(promise).rejects.toMatchObject({ status: 0, code: 'STREAM_INTERRUPTED' });
    expect(received).toHaveLength(1);
  });

  it('rethrows an AbortError when the signal aborts while streaming', async () => {
    const fake = new FakeFetch();
    const controller = new AbortController();
    const promise = collect(
      streamSse('/api/chat', {}, { fetch: fake.fn, signal: controller.signal }),
    );
    await settle();
    expect(fake.requests[0]?.init.signal).toBe(controller.signal);
    const stream = fake.respondStream();
    stream.push('event: token\ndata: {"text":"a"}\n\n');
    await settle();
    controller.abort();

    const error = await promise.catch((e: unknown) => e);
    expect(isAbortError(error)).toBe(true);
  });

  it('rethrows an AbortError when the signal aborts before the response', async () => {
    const fake = new FakeFetch();
    const controller = new AbortController();
    const promise = collect(
      streamSse('/api/chat', {}, { fetch: fake.fn, signal: controller.signal }),
    );
    await settle();
    controller.abort();

    expect(isAbortError(await promise.catch((e: unknown) => e))).toBe(true);
  });

  it('cancels the response body when the consumer stops early', async () => {
    const fake = new FakeFetch();
    const promise = (async () => {
      for await (const message of streamSse('/api/chat', {}, { fetch: fake.fn })) {
        if (message.event === 'token') {
          break;
        }
      }
    })();
    await settle();
    const stream = fake.respondStream();
    stream.push('event: token\ndata: {"text":"a"}\n\n');
    await promise;

    expect(stream.cancelled).toBe(true);
  });

  it('gives up with STREAM_INTERRUPTED when no bytes arrive within the idle timeout', async () => {
    const fake = new FakeFetch();
    const promise = collect(streamSse('/api/chat', {}, { fetch: fake.fn, idleTimeoutMs: 40 }));
    await settle();
    const stream = fake.respondStream();
    // Heartbeats keep the stream alive …
    for (let i = 0; i < 3; i++) {
      stream.push(': heartbeat\n\n');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // … silence does not.
    await expect(promise).rejects.toMatchObject({ status: 0, code: 'STREAM_INTERRUPTED' });
    expect(stream.cancelled).toBe(true);
  });

  it('drops an incomplete last frame at the end of the stream', async () => {
    const fake = new FakeFetch();
    const promise = collect(streamSse('/api/chat', {}, { fetch: fake.fn }));
    await settle();
    const stream = fake.respondStream();
    stream.push('event: token\ndata: {"text":"a"}\n\nevent: done\ndata: {}');
    stream.close();

    await expect(promise).resolves.toEqual([{ event: 'token', data: '{"text":"a"}' }]);
  });
});
