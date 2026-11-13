import { describe, expect, it } from 'vitest';
import {
  buildSourceUrl,
  repositoryLocation,
  toSourceRecord,
  validateSourceUrl,
} from '../../src/modules/collections/collection-source.js';

const SHA = 'a'.repeat(40);
const NOW = new Date('2026-11-11T12:00:00.000Z');

describe('validateSourceUrl', () => {
  it.each([
    'https://github.com/guiexperttable/mono',
    'https://github.com/guiexperttable/mono.git',
    'ssh://git@github.com/owner/repo.git',
    'git@github.com:owner/repo.git',
    'https://git.example.com:8443/team/repo',
  ])('accepts %s', (url) => {
    expect(validateSourceUrl(url)).toBe(url);
  });

  it.each([
    ['https://user:token@github.com/o/r', 'credentials'],
    ['https://ghp_secret@github.com/o/r', 'credentials'],
    ['https://guiexperttable@github.com/guiexperttable/mono.git', 'credentials'],
    ['ssh://git:password@github.com/o/r', 'credentials'],
    ['http://github.com/o/r', 'https://'],
    ['file:///etc/passwd', 'https://'],
    ['javascript:alert(1)', 'https://'],
    ['https://github.com/o/r?token=x', 'query'],
    ['https://github.com/o r', 'whitespace'],
    ['not a url', 'whitespace'],
    ['', '1–'],
  ])('rejects %s', (url, hint) => {
    let message = '';
    try {
      validateSourceUrl(url);
    } catch (error) {
      message = (error as Error).message;
      expect(error).toMatchObject({ statusCode: 400, code: 'INVALID_SOURCE' });
    }
    expect(message).toContain(hint);
    // The value itself (possibly a token) is never echoed.
    expect(message).not.toContain('secret');
    expect(message).not.toContain('token@');
  });
});

describe('toSourceRecord', () => {
  it('validates ref and commit and sets importedAt', () => {
    expect(
      toSourceRecord(
        { kind: 'git', url: 'https://github.com/o/r', ref: 'main', commit: SHA.toUpperCase() },
        NOW,
      ),
    ).toEqual({
      kind: 'git',
      url: 'https://github.com/o/r',
      ref: 'main',
      commit: SHA,
      importedAt: '2026-11-11T12:00:00.000Z',
    });
    expect(toSourceRecord({ kind: 'directory' }, NOW)).toMatchObject({
      url: null,
      ref: null,
      commit: null,
    });
  });

  it.each([
    [{ kind: 'git' as const, commit: 'abc' }],
    [{ kind: 'git' as const, commit: 'g'.repeat(40) }],
    [{ kind: 'git' as const, ref: 'main branch' }],
    [{ kind: 'git' as const, ref: '../../x\u0000' }],
  ])('rejects %j', (input) => {
    expect(() => toSourceRecord(input, NOW)).toThrow(
      expect.objectContaining({ code: 'INVALID_SOURCE' }),
    );
  });
});

describe('buildSourceUrl', () => {
  const source = (url: string, commit: string | null = SHA) => ({
    kind: 'git' as const,
    url,
    ref: 'main',
    commit,
    importedAt: NOW.toISOString(),
  });

  it('links to the lines at the commit for known hosts', () => {
    expect(buildSourceUrl(source('https://github.com/o/r.git'), 'src/a b.ts', 10, 42)).toBe(
      `https://github.com/o/r/blob/${SHA}/src/a%20b.ts#L10-L42`,
    );
    expect(buildSourceUrl(source('git@github.com:o/r.git'), 'x.ts', 1, 1)).toBe(
      `https://github.com/o/r/blob/${SHA}/x.ts#L1-L1`,
    );
    expect(buildSourceUrl(source('https://gitlab.com/g/sub/r'), 'x.ts', 3, 4)).toBe(
      `https://gitlab.com/g/sub/r/-/blob/${SHA}/x.ts#L3-4`,
    );
    expect(buildSourceUrl(source('https://bitbucket.org/o/r'), 'x.ts', 3, 4)).toBe(
      `https://bitbucket.org/o/r/src/${SHA}/x.ts#lines-3:4`,
    );
    expect(buildSourceUrl(source('https://codeberg.org/o/r'), 'x.ts', null, null)).toBe(
      `https://codeberg.org/o/r/src/commit/${SHA}/x.ts`,
    );
  });

  it('encodes path segments so a path cannot change the URL structure', () => {
    const url = buildSourceUrl(source('https://github.com/o/r'), 'a/#x?y=%2F/..%2F.ts', 1, 2);
    expect(url).toBe(`https://github.com/o/r/blob/${SHA}/a/%23x%3Fy%3D%252F/..%252F.ts#L1-L2`);
    expect(new URL(url ?? '').host).toBe('github.com');
  });

  it('returns null without commit, path, known host or valid repository name', () => {
    expect(buildSourceUrl(source('https://github.com/o/r', null), 'x.ts', 1, 2)).toBeNull();
    expect(buildSourceUrl(source('https://github.com/o/r'), null, 1, 2)).toBeNull();
    expect(buildSourceUrl(source('https://example.com/o/r'), 'x.ts', 1, 2)).toBeNull();
    expect(buildSourceUrl(source('https://github.com/o'), 'x.ts', 1, 2)).toBeNull();
    expect(buildSourceUrl(source('https://github.com/o/r/extra'), 'x.ts', 1, 2)).toBeNull();
    expect(buildSourceUrl(null, 'x.ts', 1, 2)).toBeNull();
    expect(buildSourceUrl({ ...source('https://github.com/o/r'), commit: 'main' }, 'x', 1, 1)).toBeNull();
  });

  it('parses repository locations', () => {
    expect(repositoryLocation('https://www.github.com/o/r/')).toEqual({
      host: 'github.com',
      repository: 'o/r',
    });
    expect(repositoryLocation('https://github.com:444/o/r')).toBeUndefined();
  });
});
