import { describe, expect, it } from 'vitest';
import {
  fileExtension,
  MAX_FILENAME_LENGTH,
  resolveMimeType,
  sanitizeFilename,
} from '../src/modules/ingestion/file-type.js';
import { sha256Hex } from '../src/modules/ingestion/hash.js';

describe('resolveMimeType (allowlist)', () => {
  it('derives the MIME type from allowed extensions, case-insensitively', () => {
    expect(resolveMimeType('README.md')).toBe('text/markdown');
    expect(resolveMimeType('guide.MARKDOWN')).toBe('text/markdown');
    expect(resolveMimeType('notes.Txt')).toBe('text/plain');
  });

  it('rejects everything else', () => {
    for (const name of [
      'paper.pdf',
      'setup.exe',
      'notes.md.exe',
      'archive.zip',
      'image.png',
      'bundle.wasm',
      '.env',
      'id_rsa',
      'README',
      'notes.txt ',
      'constructor',
      'x.toString',
    ]) {
      expect(resolveMimeType(name), name).toBeUndefined();
    }
  });
});

describe('fileExtension', () => {
  it('returns the last extension in lower case', () => {
    expect(fileExtension('a.b.MD')).toBe('.md');
    expect(fileExtension('noext')).toBe('');
  });
});

describe('sanitizeFilename', () => {
  it('keeps only the last path segment', () => {
    expect(sanitizeFilename('../../etc/passwd.txt')).toBe('passwd.txt');
    expect(sanitizeFilename('C:\\Users\\me\\notes.md')).toBe('notes.md');
  });

  it('removes control and bidi characters and trims', () => {
    expect(sanitizeFilename('  a\u0000b\u0007\n.md  ')).toBe('ab.md');
    expect(sanitizeFilename('invoice\u202Etxt.exe')).toBe('invoicetxt.exe');
  });

  it('applies NFC', () => {
    expect(sanitizeFilename('Cafe\u0301.md')).toBe('Caf\u00E9.md');
  });

  it('falls back to "untitled" for empty or dot-only names', () => {
    expect(sanitizeFilename('')).toBe('untitled');
    expect(sanitizeFilename('dir/')).toBe('untitled');
    expect(sanitizeFilename('..')).toBe('untitled');
  });

  it('limits the length but keeps the extension', () => {
    const sanitized = sanitizeFilename(`${'ä'.repeat(400)}.markdown`);
    expect(Array.from(sanitized)).toHaveLength(MAX_FILENAME_LENGTH);
    expect(sanitized.endsWith('.markdown')).toBe(true);
  });

  it('does not split surrogate pairs when truncating', () => {
    const sanitized = sanitizeFilename(`${'👋'.repeat(300)}.md`);
    expect(Array.from(sanitized)).toHaveLength(MAX_FILENAME_LENGTH);
    expect(sanitized).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('sha256Hex', () => {
  it('hashes the UTF-8 text as hex', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('ü')).toHaveLength(64);
  });
});
