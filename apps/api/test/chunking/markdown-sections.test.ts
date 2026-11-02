import { describe, expect, it } from 'vitest';
import {
  findAtxHeadings,
  splitMarkdownSections,
} from '../../src/modules/chunking/markdown-sections.js';

describe('findAtxHeadings', () => {
  it('finds ATX headings with level, text and line offset', () => {
    const text = 'Intro\n# One #\n  ### Three\n######  Six  ##  ';
    expect(findAtxHeadings(text)).toEqual([
      { level: 1, text: 'One', start: 6 },
      { level: 3, text: 'Three', start: 14 },
      { level: 6, text: 'Six', start: 26 },
    ]);
  });

  it('ignores headings in code fences, front matter, empty and malformed headings', () => {
    const text = [
      '---',
      '# yaml comment',
      '---',
      '#hashtag',
      '# ',
      '####### seven',
      '    # indented code',
      '````',
      '# in fence',
      '```',
      '# still in fence (shorter closing fence)',
      '````',
      '# Real',
    ].join('\n');
    expect(findAtxHeadings(text).map((heading) => heading.text)).toEqual(['Real']);
  });

  it('does not recognise setext headings', () => {
    expect(findAtxHeadings('Title\n=====\n\nSub\n---\n')).toEqual([]);
  });

  it('treats an unclosed fence as code until the end', () => {
    expect(findAtxHeadings('# A\n```\n# B')).toHaveLength(1);
  });
});

describe('splitMarkdownSections', () => {
  it('covers the text without gaps and tracks the heading path as a stack', () => {
    const text = 'pre\n# A\na\n### C\nc\n## B\n';
    const sections = splitMarkdownSections(text);
    expect(sections.map((s) => [s.start, s.end, s.headingPath, s.level])).toEqual([
      [0, 4, [], 0],
      [4, 10, ['A'], 1],
      [10, 18, ['A', 'C'], 3],
      [18, 23, ['A', 'B'], 2],
    ]);
    expect(sections.map((s) => text.slice(s.start, s.end)).join('')).toBe(text);
  });

  it('marks heading-only sections and the end of the heading line', () => {
    const [a, b] = splitMarkdownSections('# A\n\n## B\ntext');
    expect(a).toMatchObject({ headingOnly: true, bodyStart: 3 });
    expect(b).toMatchObject({ headingOnly: false, bodyStart: 9 });
  });

  it('returns a single preamble section without headings', () => {
    expect(splitMarkdownSections('just text')).toEqual([
      { start: 0, end: 9, headingPath: [], bodyStart: 0, level: 0, headingOnly: false },
    ]);
  });
});
