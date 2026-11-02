import { describe, expect, it } from 'vitest';
import { parseSseChunk, readSseStream } from '../src/sse.js';

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe('parseSseChunk', () => {
  it('parses complete frames and keeps the incomplete rest', () => {
    const result = parseSseChunk('', 'event: token\ndata: {"text":"a"}\n\nevent: done\ndata: {');
    expect(result.events).toEqual([{ event: 'token', data: '{"text":"a"}' }]);
    expect(result.rest).toBe('event: done\ndata: {');
  });

  it('handles CRLF, CR, comments, multi-line data, default event names and frames without data', () => {
    const result = parseSseChunk(
      '',
      ': heartbeat\r\n\r\nevent: a\r\ndata: 1\r\ndata: 2\r\n\r\ndata:x\r\rid: 5\nevent: empty\n\n',
      true,
    );
    expect(result.events).toEqual([
      { event: 'a', data: '1\n2' },
      { event: 'message', data: 'x' },
    ]);
    expect(result.rest).toBe('');
  });

  it('holds a trailing CR until the next chunk (CRLF split across chunks)', () => {
    const first = parseSseChunk('', 'data: 1\r\n\r');
    expect(first.events).toEqual([]);
    const second = parseSseChunk(first.rest, '\n');
    expect(second.events).toEqual([{ event: 'message', data: '1' }]);
  });
});

describe('readSseStream', () => {
  it('yields events split across network chunks and multi-byte characters', async () => {
    const events = [];
    for await (const event of readSseStream(
      streamOf('event: tok', 'en\ndata: {"text":"ä', '€"}\n', '\nevent: done\ndata: {}\n\n'),
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { event: 'token', data: '{"text":"ä€"}' },
      { event: 'done', data: '{}' },
    ]);
  });

  it('drops an incomplete last frame', async () => {
    const events = [];
    for await (const event of readSseStream(streamOf('data: 1\n\ndata: 2'))) {
      events.push(event);
    }
    expect(events).toEqual([{ event: 'message', data: '1' }]);
  });
});
