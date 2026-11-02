import { PassThrough } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSseWriter, formatSseComment, formatSseEvent } from '../../src/modules/chat/sse.js';
import { parseSse } from '../sse.js';

afterEach(() => {
  vi.useRealTimers();
});

/** A writable stand-in for a ServerResponse that records what was written. */
function fakeResponse() {
  const stream = new PassThrough();
  let written = '';
  stream.on('data', (chunk: Buffer) => (written += chunk.toString('utf8')));
  return {
    response: stream as unknown as ServerResponse,
    stream,
    written: () => written,
  };
}

describe('SSE framing', () => {
  it('formats an event with JSON data on one line', () => {
    expect(formatSseEvent('token', { text: 'a\nb\r\nc' })).toBe(
      'event: token\ndata: {"text":"a\\nb\\r\\nc"}\n\n',
    );
  });

  it('round-trips through the test parser', () => {
    const body =
      formatSseEvent('sources', { sources: [] }) +
      formatSseComment('heartbeat') +
      formatSseEvent('done', { answerStatus: 'answered' });
    expect(parseSse(body)).toEqual([
      { event: 'sources', data: { sources: [] } },
      { event: 'done', data: { answerStatus: 'answered' } },
    ]);
  });

  it('rejects event names with line breaks', () => {
    expect(() => formatSseEvent('a\nb', {})).toThrow();
  });

  it('keeps comments on one line', () => {
    expect(formatSseComment('a\nb')).toBe(': a b\n\n');
  });
});

describe('createSseWriter', () => {
  it('writes events, closes once and ignores writes after close', async () => {
    const { response, stream, written } = fakeResponse();
    const writer = createSseWriter(response, { heartbeatMs: 0 });

    await writer.send('token', { text: 'hi' });
    writer.close();
    writer.close();
    await writer.send('token', { text: 'late' });
    await new Promise((resolve) => stream.once('end', resolve));

    expect(writer.closed).toBe(true);
    expect(parseSse(written())).toEqual([{ event: 'token', data: { text: 'hi' } }]);
  });

  it('sends heartbeat comments while open', async () => {
    vi.useFakeTimers();
    const { response, written } = fakeResponse();
    const writer = createSseWriter(response, { heartbeatMs: 1000 });

    await vi.advanceTimersByTimeAsync(2500);
    writer.close();
    await vi.advanceTimersByTimeAsync(2000);

    expect(written().match(/: heartbeat\n\n/g)).toHaveLength(2);
  });
});
