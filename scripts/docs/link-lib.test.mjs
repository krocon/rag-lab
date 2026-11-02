// @ts-check
import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { describe, it } from 'node:test';
import { checkDocument, extractLinks, headingAnchors, isExternal, slugify } from './link-lib.mjs';

describe('slugify', () => {
  for (const [heading, slug] of [
    ['2. Chunking (deterministisch)', '2-chunking-deterministisch'],
    ['Security & limitations', 'security--limitations'],
    ['Retrieval transparency: distance vs. score', 'retrieval-transparency-distance-vs-score'],
    ['11. MCP-Server (Prompt 014)', '11-mcp-server-prompt-014'],
    ['Über `pnpm eval`', 'über-pnpm-eval'],
  ]) {
    it(`"${heading}" → ${slug}`, () => assert.equal(slugify(heading.replace(/`/g, '')), slug));
  }
});

describe('headingAnchors', () => {
  it('numbers duplicates and ignores headings in code blocks', () => {
    const anchors = headingAnchors(
      '# A\n\n## Setup\n\n```bash\n# not a heading\n```\n\n## Setup\n',
    );
    assert.deepEqual([...anchors], ['a', 'setup', 'setup-1']);
  });
});

describe('extractLinks', () => {
  it('finds links, images, reference definitions and HTML attributes, but not code', () => {
    const links = extractLinks(
      [
        'See [docs](docs/a.md#intro) and ![shot](img/x.webp "title").',
        '`[not](a link)` and',
        '```',
        '[also not](inside-code.md)',
        '```',
        '[ref]: https://example.invalid/x',
        '<img src="logo.png" alt="">',
      ].join('\n'),
    );
    assert.deepEqual(
      links.map((l) => [l.target, l.line]),
      [
        ['docs/a.md#intro', 1],
        ['img/x.webp', 1],
        ['https://example.invalid/x', 6],
        ['logo.png', 7],
      ],
    );
  });

  it('classifies external targets', () => {
    assert.equal(isExternal('https://x.invalid'), true);
    assert.equal(isExternal('mailto:a@b.invalid'), true);
    assert.equal(isExternal('docs/a.md'), false);
    assert.equal(isExternal('#anchor'), false);
  });
});

describe('checkDocument', () => {
  const files = {
    '/repo/README.md': '# RAGLab\n\n## Quick start\n',
    '/repo/docs/a.md': '# A\n\n## 9. Implementierungsstand\n',
    '/repo/docs/images/shot.webp': '',
  };
  /** @param {string} file @param {string} markdown */
  const check = (file, markdown) =>
    checkDocument({
      file,
      markdown,
      resolve: (from, target) => posix.join(posix.dirname(from), target),
      exists: (path) => path in files || path.replace(/\/$/, '') === '/repo/docs',
      readMarkdown: (path) => files[/** @type {keyof typeof files} */ (path)],
    });

  it('accepts existing files, directories and anchors', () => {
    assert.deepEqual(
      check(
        '/repo/README.md',
        '## Quick start\n\n[a](docs/a.md#9-implementierungsstand) ![s](docs/images/shot.webp) ' +
          '[d](docs/) ' +
          '[self](#quick-start) [web](https://example.invalid/missing)',
      ),
      [],
    );
  });

  it('reports missing files and anchors with line numbers', () => {
    assert.deepEqual(check('/repo/docs/a.md', '# A\n\n[x](missing.md)\n[y](../README.md#nope)'), [
      { line: 3, target: 'missing.md', problem: 'file not found' },
      { line: 4, target: '../README.md#nope', problem: 'no heading for #nope' },
    ]);
  });

  it('checks anchors within the same document', () => {
    assert.deepEqual(check('/repo/README.md', '# T\n\n[x](#t) [y](#missing)'), [
      { line: 3, target: '#missing', problem: 'no heading for #missing' },
    ]);
  });
});
