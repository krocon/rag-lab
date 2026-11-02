import { describe, expect, it } from 'vitest';
import {
  BoundaryLevel,
  boundaryLevel,
  endsSentence,
  findCut,
  startsSentence,
} from '../../src/modules/chunking/boundaries.js';

describe('boundaries', () => {
  it.each([
    ['Para one.\n\nNext', 9, BoundaryLevel.Paragraph],
    ['Para one \n \t\nNext', 8, BoundaryLevel.Paragraph],
    ['Sentence. Next', 9, BoundaryLevel.Sentence],
    ['Line one\nNext', 8, BoundaryLevel.Line],
    ['word next', 4, BoundaryLevel.Word],
  ])('classifies the boundary in %j at %i', (text, position, level) => {
    expect(boundaryLevel(text, position)).toBe(level);
  });

  it('recognises sentence terminators with closing punctuation', () => {
    expect(endsSentence('Done!', 5)).toBe(true);
    expect(endsSentence('Really?")', 9)).toBe(true);
    expect(endsSentence('»Ende.«', 7)).toBe(true);
    expect(endsSentence('„Ende.“', 7)).toBe(true);
    expect(endsSentence('word', 4)).toBe(false);
  });

  it('knows sentence starts (after terminators or line breaks)', () => {
    const text = 'One. Two three\nFour';
    expect(startsSentence(text, 0)).toBe(true);
    expect(startsSentence(text, 5)).toBe(true);
    expect(startsSentence(text, 9)).toBe(false);
    expect(startsSentence(text, 15)).toBe(true);
  });

  it('finds the coarsest boundary within the budget', () => {
    const text = 'Aa bb. Cc dd\n\nEe ff. Gg hh';
    expect(findCut(text, 0, 15)).toEqual({ position: 12, level: BoundaryLevel.Paragraph });
    expect(findCut(text, 0, 11)).toEqual({ position: 6, level: BoundaryLevel.Sentence });
    expect(findCut(text, 0, 5)).toEqual({ position: 2, level: BoundaryLevel.Word });
    expect(findCut('abcdefgh', 0, 5)).toEqual({ position: 5, level: BoundaryLevel.Hard });
  });

  it('ignores boundaries before minPosition unless there is no other', () => {
    expect(findCut('# H\n\nBody. More text', 0, 14, 4)).toEqual({
      position: 10,
      level: BoundaryLevel.Sentence,
    });
    // Only word ends after minPosition: cut after the heading rather than mid-sentence.
    expect(findCut('# H\n\nBody text more', 0, 12, 4).position).toBe(3);
    expect(findCut('# H\n\nBodytextlong', 0, 10, 4).position).toBe(3);
  });
});
