import { describe, expect, it } from 'vitest';
import { isBlank, normalizeText } from '../src/modules/ingestion/normalize.js';

describe('normalizeText', () => {
  it('removes a leading byte order mark only', () => {
    expect(normalizeText('\uFEFF# Title')).toBe('# Title');
    expect(normalizeText('a\uFEFFb')).toBe('a\uFEFFb');
  });

  it('converts CRLF and lone CR to LF', () => {
    expect(normalizeText('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('composes to Unicode NFC (NFD and NFC input give the same text)', () => {
    const nfd = 'Cafe\u0301 Mu\u0308ller';
    const nfc = 'Caf\u00E9 M\u00FCller';
    expect(normalizeText(nfd)).toBe(nfc);
    expect(normalizeText(nfc)).toBe(nfc);
  });

  it('removes control characters but keeps tabs and newlines', () => {
    expect(normalizeText('a\u0000b\u0007c\u001Bd\u007Fe\u0085f\tg\nh')).toBe('abcdef\tg\nh');
  });

  it('collapses more than two blank lines into two', () => {
    expect(normalizeText('a\n\n\n\n\nb')).toBe('a\n\n\nb');
    expect(normalizeText('a\n \n\t\n  \n\nb')).toBe('a\n\n\nb');
    expect(normalizeText('\n\n\n\n\nb')).toBe('\n\nb');
  });

  it('keeps up to two blank lines and whitespace inside lines unchanged', () => {
    const text = 'a\n\nb\n\n\nc\n  indented  \n\tcode';
    expect(normalizeText(text)).toBe(text);
  });

  it('collapses blank lines that only appear after CRLF conversion and control removal', () => {
    expect(normalizeText('a\r\n\r\n\u0001\r\n\r\nb')).toBe('a\n\n\nb');
  });

  it('does not rewrite Markdown or trim the text', () => {
    const text = '  # Title  \n\n- item\n\n```ts\nconst x = 1;\n```\n';
    expect(normalizeText(text)).toBe(text);
  });

  it('is idempotent', () => {
    const samples = [
      '\uFEFFa\r\n\r\n\r\n\r\nb',
      'Cafe\u0301\u0000\n\n \n\n\n\nx\r',
      '\n \n \n \n',
      'plain text',
      '',
    ];
    for (const sample of samples) {
      const once = normalizeText(sample);
      expect(normalizeText(once)).toBe(once);
    }
  });
});

describe('isBlank', () => {
  it('detects empty and whitespace-only text', () => {
    expect(isBlank('')).toBe(true);
    expect(isBlank(' \n\t\n')).toBe(true);
    expect(isBlank('\u00A0\u2003')).toBe(true);
    expect(isBlank(' x ')).toBe(false);
  });
});
