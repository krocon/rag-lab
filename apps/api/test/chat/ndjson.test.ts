import { describe, expect, it } from 'vitest';
import { NdjsonParseError, parseNdjson } from '../../src/modules/chat/ndjson.js';

async function* chunks(...parts: (string | Uint8Array)[]): AsyncGenerator<string | Uint8Array> {
  for (const part of parts) {
    await Promise.resolve();
    yield part;
  }
}

async function collect(source: AsyncIterable<unknown>): Promise<unknown[]> {
  const values: unknown[] = [];
  for await (const value of source) {
    values.push(value);
  }
  return values;
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe('parseNdjson', () => {
  it('parses one value per line', async () => {
    expect(await collect(parseNdjson(chunks('{"a":1}\n{"b":2}\n')))).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('joins lines split across chunks', async () => {
    expect(
      await collect(parseNdjson(chunks('{"te', 'xt":"he', 'llo"}\n{"done"', ':true}\n'))),
    ).toEqual([{ text: 'hello' }, { done: true }]);
  });

  it('decodes multi-byte UTF-8 characters split across chunks', async () => {
    const encoded = bytes('{"text":"Grüße 👋"}\n');
    const parts = [...encoded].map((byte) => Uint8Array.of(byte));
    expect(await collect(parseNdjson(chunks(...parts)))).toEqual([{ text: 'Grüße 👋' }]);
  });

  it('accepts a last line without newline, CRLF and blank lines', async () => {
    expect(await collect(parseNdjson(chunks('{"a":1}\r\n\r\n\n', '{"b":2}')))).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
  });

  it('yields values before a later line fails', async () => {
    const values: unknown[] = [];
    await expect(async () => {
      for await (const value of parseNdjson(chunks('{"a":1}\n{broken\n{"c":3}\n'))) {
        values.push(value);
      }
    }).rejects.toThrow(new NdjsonParseError('NDJSON line 2 is not valid JSON.'));
    expect(values).toEqual([{ a: 1 }]);
  });

  it('rejects invalid JSON without echoing the line', async () => {
    const error = await collect(parseNdjson(chunks('secret text\n'))).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NdjsonParseError);
    expect((error as Error).message).not.toContain('secret');
  });

  it('rejects an overlong line', async () => {
    await expect(
      collect(parseNdjson(chunks('x'.repeat(20), 'y'.repeat(20)), { maxLineChars: 30 })),
    ).rejects.toBeInstanceOf(NdjsonParseError);
  });

  it('stops reading when the consumer stops (done: true)', async () => {
    let pulled = 0;
    async function* source() {
      for (const line of ['{"done":false}\n', '{"done":true}\n', '{"after":1}\n']) {
        pulled++;
        yield line;
      }
    }
    for await (const value of parseNdjson(source())) {
      if ((value as { done: boolean }).done) {
        break;
      }
    }
    expect(pulled).toBe(2);
  });
});
