import { describe, expect, it } from 'vitest';
import { analyzeCitations } from '../../src/modules/chat/citations.js';

describe('analyzeCitations', () => {
  it.each([
    ['no citations', 'Plain answer.', 3, [], []],
    ['single', 'Fact [1].', 3, [1], []],
    ['list with spaces', 'Facts [1, 3].', 3, [1, 3], []],
    ['list without spaces', 'Facts [3,2].', 3, [2, 3], []],
    ['padded', 'Fact [ 2 ].', 3, [2], []],
    ['duplicates', '[1] and again [1] and [1, 1]', 3, [1], []],
    ['unknown number', 'Fact [4].', 3, [], [4]],
    ['zero', 'Fact [0].', 3, [], [0]],
    ['mixed', 'A [1, 7], B [2] and [9].', 2, [1, 2], [7, 9]],
    ['no sources at all', 'Fact [1].', 0, [], [1]],
  ])('%s', (_name, answer, count, cited, unknown) => {
    expect(analyzeCitations(answer, count)).toEqual({
      citedSources: cited,
      unknownCitations: unknown,
    });
  });

  it.each([
    ['words in brackets', 'See [note] and [a, b].'],
    ['ranges', 'Sources [1-2].'],
    ['markdown checkbox', '- [ ] todo'],
    ['decimal', 'Value [1.5].'],
    ['empty brackets', 'Empty [].'],
    ['trailing comma', 'List [1,].'],
  ])('ignores %s', (_name, answer) => {
    expect(analyzeCitations(answer, 3)).toEqual({ citedSources: [], unknownCitations: [] });
  });

  it('finds citations split across tokens once the answer is joined', () => {
    const answer = ['Answer [', '1', ', 2', ']'].join('');
    expect(analyzeCitations(answer, 2).citedSources).toEqual([1, 2]);
  });
});
