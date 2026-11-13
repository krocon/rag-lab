import {
  formatLineRange,
  formatSourceLocation,
  isCodeLanguage,
  linkHost,
  safeHttpsUrl,
  shortCommit,
} from './source-location';

describe('source location helpers', () => {
  it.each([
    [10, 42, '10–42'],
    [7, 7, '7'],
    [null, 42, null],
    [10, null, null],
    [null, null, null],
    [0, 3, null],
    [5, 4, null],
    [1.5, 3, null],
  ])('formatLineRange(%s, %s) = %s', (start, end, expected) => {
    expect(formatLineRange(start, end)).toBe(expected);
  });

  it('formats path and lines, falling back to the file name', () => {
    expect(
      formatSourceLocation({
        filename: 'tree.ts',
        path: 'packages/table/src/tree.ts',
        startLine: 10,
        endLine: 42,
      }),
    ).toBe('packages/table/src/tree.ts:10–42');
    expect(
      formatSourceLocation({ filename: 'notes.md', path: null, startLine: 3, endLine: 3 }),
    ).toBe('notes.md:3');
    expect(
      formatSourceLocation({ filename: 'notes.md', path: null, startLine: null, endLine: null }),
    ).toBe('notes.md');
    expect(
      formatSourceLocation({ filename: 'a.ts', path: 'src/a.ts', startLine: null, endLine: null }),
    ).toBe('src/a.ts');
  });

  it('accepts only https URLs without credentials', () => {
    const github = 'https://github.com/o/r/blob/abc/src/a.ts#L10-L42';
    expect(safeHttpsUrl(github)).toBe(github);
    expect(safeHttpsUrl(null)).toBeNull();
    expect(safeHttpsUrl(undefined)).toBeNull();
    expect(safeHttpsUrl('')).toBeNull();
    expect(safeHttpsUrl('http://github.com/o/r')).toBeNull();
    expect(safeHttpsUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpsUrl('data:text/html,<b>x</b>')).toBeNull();
    expect(safeHttpsUrl('HTTPS://github.com/o/r')).toBeNull();
    expect(safeHttpsUrl(' https://github.com/o/r')).toBeNull();
    expect(safeHttpsUrl('//github.com/o/r')).toBeNull();
    expect(safeHttpsUrl('https://user:secret@github.com/o/r')).toBeNull();
    expect(safeHttpsUrl('https://')).toBeNull();
  });

  it('extracts the host of safe links only', () => {
    expect(linkHost('https://gitlab.com/g/p/-/blob/abc/a.ts#L1-2')).toBe('gitlab.com');
    expect(linkHost('http://gitlab.com/g/p')).toBeNull();
    expect(linkHost(null)).toBeNull();
  });

  it('detects source code languages', () => {
    expect(isCodeLanguage('typescript')).toBe(true);
    expect(isCodeLanguage('vue')).toBe(true);
    expect(isCodeLanguage('markdown')).toBe(false);
    expect(isCodeLanguage('text')).toBe(false);
    expect(isCodeLanguage('')).toBe(false);
    expect(isCodeLanguage(null)).toBe(false);
  });

  it('shortens commit SHAs', () => {
    expect(shortCommit('0123456789abcdef0123456789abcdef01234567')).toBe('0123456789ab');
  });
});
