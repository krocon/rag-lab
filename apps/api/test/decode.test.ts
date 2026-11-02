import { describe, expect, it } from 'vitest';
import { AppError } from '../src/http/errors.js';
import { decodeUtf8 } from '../src/modules/ingestion/decode.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? `${error.statusCode} ${error.code}` : 'other';
  }
  return undefined;
}

describe('decodeUtf8', () => {
  it('decodes valid UTF-8 including multi-byte characters', () => {
    expect(decodeUtf8(Buffer.from('Grüße 👋 ✓'))).toBe('Grüße 👋 ✓');
  });

  it('removes a UTF-8 byte order mark', () => {
    expect(decodeUtf8(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toBe('a');
  });

  it('rejects invalid UTF-8 with 400 INVALID_ENCODING', () => {
    // Latin-1 "ü" and a truncated multi-byte sequence.
    expect(codeOf(() => decodeUtf8(Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x65])))).toBe(
      '400 INVALID_ENCODING',
    );
    expect(codeOf(() => decodeUtf8(Buffer.from([0xe2, 0x82])))).toBe('400 INVALID_ENCODING');
  });

  it('rejects NUL bytes (binary files, UTF-16) with 400 INVALID_ENCODING', () => {
    expect(codeOf(() => decodeUtf8(Buffer.from([0x61, 0x00, 0x62])))).toBe('400 INVALID_ENCODING');
    expect(codeOf(() => decodeUtf8(Buffer.from('hi', 'utf16le')))).toBe('400 INVALID_ENCODING');
  });

  it('names the file in the error', () => {
    try {
      decodeUtf8(Buffer.from([0xff]), 'notes.txt');
    } catch (error) {
      expect((error as AppError).message).toContain('notes.txt');
      expect((error as AppError).details).toEqual({ filename: 'notes.txt' });
    }
  });

  it('accepts an empty file (emptiness is checked after normalisation)', () => {
    expect(decodeUtf8(new Uint8Array())).toBe('');
  });
});
