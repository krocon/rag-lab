// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IgnoreMatcher, parseIgnoreLine } from './gitignore.mjs';

/** @param {string | string[]} patterns @param {string} [base] */
const matcher = (patterns, base = '') => new IgnoreMatcher().add(patterns, base);

describe('parseIgnoreLine', () => {
  it('skips blank lines and comments, keeps escaped ones', () => {
    assert.equal(parseIgnoreLine(''), undefined);
    assert.equal(parseIgnoreLine('   '), undefined);
    assert.equal(parseIgnoreLine('# comment'), undefined);
    assert.ok(parseIgnoreLine('\\#file')?.regex.test('#file'));
    assert.ok(parseIgnoreLine('\\!important')?.regex.test('!important'));
  });
});

describe('IgnoreMatcher', () => {
  it('matches names without a slash at any depth', () => {
    const m = matcher(['*.log', 'secret.txt']);
    assert.ok(m.ignores('a.log'));
    assert.ok(m.ignores('deep/dir/a.log'));
    assert.ok(m.ignores('x/secret.txt'));
    assert.ok(!m.ignores('a.log.txt'));
  });

  it('anchors patterns with a slash to the directory of the ignore file', () => {
    const m = matcher(['/build', 'docs/api/'], '');
    assert.ok(m.ignores('build/a.ts'));
    assert.ok(!m.ignores('src/build/a.ts'));
    assert.ok(m.ignores('docs/api/x.md'));
    assert.ok(!m.ignores('x/docs/api/x.md'));
    const nested = matcher(['/generated', '*.tmp'], 'apps/web');
    assert.ok(nested.ignores('apps/web/generated/a.ts'));
    assert.ok(nested.ignores('apps/web/src/a.tmp'));
    assert.ok(!nested.ignores('generated/a.ts'));
    assert.ok(!nested.ignores('apps/other/a.tmp'));
  });

  it('matches directory-only patterns for directories and their content only', () => {
    const m = matcher(['cache/']);
    assert.ok(m.ignores('cache', true));
    assert.ok(!m.ignores('cache', false));
    assert.ok(m.ignores('a/cache/b.ts'));
  });

  it('supports **, ?, character classes and negation (last rule wins)', () => {
    const m = matcher(['**/fixtures/**', 'a/**/z.ts', 'file?.md', '[abc].ts', '[!x]y.ts', '*.md', '!keep.md']);
    assert.ok(m.ignores('fixtures/a.ts'));
    assert.ok(m.ignores('x/fixtures/y/z.ts'));
    assert.ok(m.ignores('a/z.ts'));
    assert.ok(m.ignores('a/b/c/z.ts'));
    assert.ok(m.ignores('file1.md'));
    assert.ok(m.ignores('b.ts'));
    assert.ok(!m.ignores('d.ts'));
    assert.ok(m.ignores('ay.ts'));
    assert.ok(!m.ignores('xy.ts'));
    assert.ok(m.ignores('notes.md'));
    assert.ok(!m.ignores('keep.md'));
    assert.ok(!m.ignores('dir/keep.md'));
  });

  it('cannot re-include a file inside an ignored directory (like Git)', () => {
    const m = matcher(['logs/', '!logs/keep.txt']);
    assert.ok(m.ignores('logs/keep.txt'));
  });

  it('treats regex characters in patterns literally', () => {
    const m = matcher(['a+b(1).ts', 'x.y']);
    assert.ok(m.ignores('a+b(1).ts'));
    assert.ok(m.ignores('x.y'));
    assert.ok(!m.ignores('xzy'));
  });
});
