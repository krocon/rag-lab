import { describe, expect, it } from 'vitest';
import {
  chunkingFormatFor,
  chunkText,
  type ChunkingOptions,
} from '../../src/modules/chunking/chunker.js';
import { expectChunkInvariants } from './invariants.js';

const md = (targetSize: number, overlap = 0): ChunkingOptions => ({
  targetSize,
  overlap,
  format: 'markdown',
});
const txt = (targetSize: number, overlap = 0): ChunkingOptions => ({
  targetSize,
  overlap,
  format: 'text',
});

function chunk(text: string, options: ChunkingOptions) {
  const chunks = chunkText(text, options);
  expectChunkInvariants(text, chunks, options);
  return chunks;
}

const contents = (text: string, options: ChunkingOptions) =>
  chunk(text, options).map((c) => c.content);

describe('chunkText – table tests', () => {
  it.each([
    { name: 'empty text', text: '', expected: [] },
    { name: 'whitespace only', text: ' \n\n\t \n', expected: [] },
    { name: 'short text', text: 'Hello world.', expected: ['Hello world.'] },
    { name: 'trims surrounding whitespace', text: '\n\n  Hello  \n', expected: ['Hello'] },
    {
      name: 'merges small paragraphs up to the target size',
      text: 'One.\n\nTwo.\n\nThree.',
      expected: ['One.\n\nTwo.\n\nThree.'],
    },
  ])('$name', ({ text, expected }) => {
    expect(contents(text, txt(100))).toEqual(expected);
  });

  it('prefers paragraph ends over sentence ends', () => {
    const text = 'Alpha one. Alpha two.\n\nBeta one. Beta two.';
    expect(contents(text, txt(30))).toEqual(['Alpha one. Alpha two.', 'Beta one. Beta two.']);
  });

  it('splits text without paragraphs at sentence ends', () => {
    const text = 'First sentence here. Second one! Third? Fourth sentence.';
    expect(contents(text, txt(35))).toEqual([
      'First sentence here. Second one!',
      'Third? Fourth sentence.',
    ]);
  });

  it('treats closing quotes and brackets after the terminator as part of the sentence', () => {
    const text = 'He said "stop." Then (finally.) it ended.';
    expect(contents(text, txt(20))).toEqual(['He said "stop."', 'Then (finally.)', 'it ended.']);
  });

  it('uses line ends below sentence ends (lists, code)', () => {
    const text = '- apples and pears\n- bananas and kiwis\n- cherries';
    expect(contents(text, txt(40))).toEqual([
      '- apples and pears\n- bananas and kiwis',
      '- cherries',
    ]);
  });

  it('splits at word boundaries when there is no sentence or line end', () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta';
    expect(contents(text, txt(12))).toEqual([
      'alpha beta',
      'gamma delta',
      'epsilon zeta',
      'eta theta',
    ]);
  });

  it('cuts a word longer than the target size hard', () => {
    const word = 'x'.repeat(25);
    const chunks = chunk(`short ${word} end`, txt(10));
    expect(chunks.map((c) => c.content)).toEqual([
      'short',
      'xxxxxxxxxx',
      'xxxxxxxxxx',
      'xxxxx end',
    ]);
  });

  it('never splits a surrogate pair on a hard cut', () => {
    const text = '😀😀😀😀😀'; // 10 UTF-16 code units, no whitespace
    const chunks = chunk(text, txt(3));
    expect(chunks.map((c) => c.content)).toEqual(['😀', '😀', '😀', '😀', '😀']);
    // targetSize 1: a pair is taken as a whole (2 code units), the only allowed excess.
    expect(chunk('😀a', txt(1)).map((c) => c.content)).toEqual(['😀', 'a']);
  });

  it('keeps offsets in UTF-16 code units consistent with String.prototype.slice', () => {
    const text = 'Größe 😀 über alles.\n\nZweiter Absatz mit Ümläuten und 👩‍💻 Emoji.';
    const chunks = chunk(text, txt(25, 8));
    for (const c of chunks) {
      expect(text.slice(c.startOffset, c.endOffset)).toBe(c.content);
    }
    expect(chunks[0]?.content).toBe('Größe 😀 über alles.');
  });

  it('is deterministic', () => {
    const text = '# A\n\nSome text. More text!\n\n## B\n\nOther words here and there.';
    expect(chunkText(text, md(20, 8))).toEqual(chunkText(text, md(20, 8)));
  });

  it('computes tokenEstimate as ceil(charCount / 4)', () => {
    const [only] = chunk('abcde', txt(10));
    expect(only).toMatchObject({ charCount: 5, tokenEstimate: 2 });
  });

  it('rejects invalid options', () => {
    expect(() => chunkText('x', txt(0))).toThrow(RangeError);
    expect(() => chunkText('x', txt(10, 10))).toThrow(RangeError);
    expect(() => chunkText('x', txt(10, -1))).toThrow(RangeError);
    expect(() => chunkText('x', txt(1.5))).toThrow(RangeError);
  });
});

describe('chunkText – overlap', () => {
  const sentences =
    'One two three. Four five six. Seven eight nine. Ten eleven twelve. Thirteen fourteen.';

  it('has no overlap with overlap = 0', () => {
    const chunks = chunk(sentences, txt(30, 0));
    expect(chunks.every((c) => c.overlapChars === 0)).toBe(true);
    expect(chunks.map((c) => c.content)).toEqual([
      'One two three. Four five six.',
      'Seven eight nine.',
      'Ten eleven twelve.',
      'Thirteen fourteen.',
    ]);
  });

  it('starts the overlap at a sentence start when it keeps at least half of the overlap', () => {
    const chunks = chunk(sentences, txt(40, 20));
    expect(chunks[1]?.content.startsWith('Four five six.')).toBe(true);
    expect(chunks[1]?.overlapChars).toBe('Four five six. '.length);
  });

  it('falls back to a word start for the overlap', () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';
    const chunks = chunk(text, txt(20, 8));
    expect(chunks.map((c) => c.content)).toEqual([
      'alpha beta gamma',
      'gamma delta epsilon',
      'epsilon zeta eta',
      'eta theta iota kappa',
    ]);
  });

  it('does not overlap into a hard-cut word', () => {
    const chunks = chunk(`${'y'.repeat(30)} tail words`, txt(10, 5));
    expect(chunks.map((c) => [c.content, c.overlapChars])).toEqual([
      ['yyyyyyyyyy', 0],
      ['yyyyyyyyyy', 0],
      ['yyyyyyyyyy', 0],
      ['tail words', 0],
    ]);
  });

  it('works with an overlap just below targetSize', () => {
    const chunks = chunk('aa bb cc dd ee', txt(12, 11));
    expect(chunks.map((c) => [c.content, c.overlapChars])).toEqual([
      ['aa bb cc dd', 0],
      ['bb cc dd ee', 9],
    ]);
  });

  it('shrinks the overlap so that the next word still fits instead of cutting it hard', () => {
    // "eeeeeeeeee" (10) fits into 12 only with an overlap of at most 2.
    const chunks = chunk('aa bb cc dd eeeeeeeeee ff gg', txt(12, 11));
    expect(chunks.map((c) => c.content)).toEqual(['aa bb cc dd', 'eeeeeeeeee', 'ff gg']);
  });

  it('never overlaps across heading sections', () => {
    const text = '# A\n\nAlpha text here.\n\n# B\n\nBeta text here.';
    const chunks = chunk(text, md(20, 10));
    const firstOfB = chunks.find((c) => c.headingPath[0] === 'B');
    expect(firstOfB?.overlapChars).toBe(0);
    expect(firstOfB?.content.startsWith('# B')).toBe(true);
  });
});

describe('chunkText – Markdown headings', () => {
  it('assigns heading paths, also across level jumps', () => {
    const text = '# Guide\n\nIntro.\n\n### Deep\n\nDeep text.\n\n## Install\n\nInstall text.';
    const chunks = chunk(text, md(1000));
    expect(chunks.map((c) => [c.headingPath, c.content])).toEqual([
      [['Guide'], '# Guide\n\nIntro.'],
      [['Guide', 'Deep'], '### Deep\n\nDeep text.'],
      [['Guide', 'Install'], '## Install\n\nInstall text.'],
    ]);
  });

  it('pops headings of the same or a deeper level', () => {
    const text = '# A\nx\n## B\ny\n### C\nz\n## D\nw\n# E\nv';
    expect(chunk(text, md(1000)).map((c) => c.headingPath)).toEqual([
      ['A'],
      ['A', 'B'],
      ['A', 'B', 'C'],
      ['A', 'D'],
      ['E'],
    ]);
  });

  it('gives text before the first heading an empty path', () => {
    const chunks = chunk('Preamble.\n\n# Title\n\nBody.', md(1000));
    expect(chunks.map((c) => c.headingPath)).toEqual([[], ['Title']]);
  });

  it('ignores # lines inside fenced code blocks', () => {
    const text = '# Setup\n\n```bash\n# install\nnpm i\n```\n\n~~~\n## not a heading\n~~~\n\nDone.';
    const chunks = chunk(text, md(1000));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.headingPath).toEqual(['Setup']);
  });

  it('does not treat headings as boundaries in plain text', () => {
    const chunks = chunk('# Not a heading\n\nText.', txt(1000));
    expect(chunks.map((c) => c.headingPath)).toEqual([[]]);
  });

  it('merges heading-only sections into the following deeper section', () => {
    const text = '# Guide\n\n## Install\n\n### Docker\n\nRun it.\n\n## Usage\n\n# Next\n\nText.';
    const chunks = chunk(text, md(1000));
    expect(chunks.map((c) => [c.headingPath, c.content])).toEqual([
      [['Guide', 'Install', 'Docker'], '# Guide\n\n## Install\n\n### Docker\n\nRun it.'],
      // "## Usage" is followed by a shallower heading, so it stays a chunk of its own.
      [['Guide', 'Usage'], '## Usage'],
      [['Next'], '# Next\n\nText.'],
    ]);
  });

  it('handles a document consisting of headings only', () => {
    const chunks = chunk('# A\n## B\n## C\n# D', md(1000));
    expect(chunks.map((c) => [c.headingPath, c.content])).toEqual([
      [['A', 'B'], '# A\n## B'],
      [['A', 'C'], '## C'],
      [['D'], '# D'],
    ]);
  });

  it('keeps the heading line together with the start of its body', () => {
    const text = '## Title\n\nA first paragraph that is long.\n\nSecond.';
    const chunks = chunk(text, md(45));
    expect(chunks[0]?.content).toBe('## Title\n\nA first paragraph that is long.');
  });

  it('rather emits the heading alone than cutting its first sentence mid-way', () => {
    const text = '## Title\n\nA first sentence that does not fit.';
    expect(contents(text, md(30))).toEqual(['## Title', 'A first sentence that does not', 'fit.']);
  });

  it('splits long sections and keeps the heading path on every chunk', () => {
    const body = Array.from({ length: 20 }, (_, i) => `Sentence number ${i}.`).join(' ');
    const chunks = chunk(`# Long\n\n${body}`, md(80, 20));
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.headingPath.join('/') === 'Long')).toBe(true);
  });
});

describe('chunkingFormatFor', () => {
  it('maps MIME types to the chunking format', () => {
    expect(chunkingFormatFor('text/markdown')).toBe('markdown');
    expect(chunkingFormatFor('text/plain')).toBe('text');
  });
});
