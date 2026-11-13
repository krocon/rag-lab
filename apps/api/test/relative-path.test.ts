import { describe, expect, it } from 'vitest';
import {
  checkRelativePath,
  MAX_PATH_LENGTH,
  validateRelativePath,
} from '../src/modules/ingestion/relative-path.js';

describe('checkRelativePath', () => {
  it('accepts relative paths with "/" separators and returns them in NFC', () => {
    expect(checkRelativePath('packages/table/src/x.ts')).toEqual({
      ok: true,
      path: 'packages/table/src/x.ts',
    });
    expect(checkRelativePath('README.md')).toEqual({ ok: true, path: 'README.md' });
    expect(checkRelativePath('docs/Gro\u0308ße.md')).toEqual({ ok: true, path: 'docs/Größe.md' });
    expect(checkRelativePath('a/.github/workflows/ci.yml').ok).toBe(true);
    expect(checkRelativePath('a/b c/d.ts').ok).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['../x.ts', 'dot_segment'],
    ['a/../../etc/passwd.txt', 'dot_segment'],
    ['./a.ts', 'dot_segment'],
    ['/etc/passwd.txt', 'absolute'],
    ['C:/Users/a.ts', 'absolute'],
    ['a\\b.ts', 'backslash'],
    ['a//b.ts', 'empty_segment'],
    ['a/b/', 'empty_segment'],
    ['a/\u0000b.ts', 'unsafe_characters'],
    ['a/b\n.ts', 'unsafe_characters'],
    ['invoice\u202Etxt.exe', 'unsafe_characters'],
    ['a/\u200Bb.ts', 'unsafe_characters'],
    [' a/b.ts', 'surrounding_whitespace'],
    ['a /b.ts', 'surrounding_whitespace'],
    [`${'a/'.repeat(300)}b.ts`, 'too_long'],
    [`${'a'.repeat(256)}.ts`, 'segment_too_long'],
  ])('rejects %j (%s)', (raw, reason) => {
    expect(checkRelativePath(raw)).toEqual({ ok: false, reason });
  });

  it('accepts exactly MAX_PATH_LENGTH characters', () => {
    const path = `${'a/'.repeat((MAX_PATH_LENGTH - 4) / 2)}b.ts`;
    expect(Array.from(path)).toHaveLength(MAX_PATH_LENGTH);
    expect(checkRelativePath(path).ok).toBe(true);
  });

  it('throws 400 INVALID_PATH without echoing the value', () => {
    expect(() => validateRelativePath('../secret\u0007.ts', 'x.ts')).toThrow(
      expect.objectContaining({
        statusCode: 400,
        code: 'INVALID_PATH',
        details: { filename: 'x.ts', reason: 'unsafe_characters' },
      }),
    );
    try {
      validateRelativePath('../secret.ts', 'x.ts');
    } catch (error) {
      expect((error as Error).message).not.toContain('secret');
    }
  });
});
