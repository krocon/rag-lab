import { segmentAnswer } from './citations';

const known = new Set([1, 2, 3]);

describe('segmentAnswer', () => {
  it('returns plain text as one segment', () => {
    expect(segmentAnswer('No citations here.', known)).toEqual([
      { type: 'text', text: 'No citations here.' },
    ]);
  });

  it('splits valid citations out of the text', () => {
    expect(segmentAnswer('Reindex it [1]. Then wait [2].', known)).toEqual([
      { type: 'text', text: 'Reindex it ' },
      { type: 'citation', raw: '[1]', refs: [{ n: 1, known: true }] },
      { type: 'text', text: '. Then wait ' },
      { type: 'citation', raw: '[2]', refs: [{ n: 2, known: true }] },
      { type: 'text', text: '.' },
    ]);
  });

  it('marks numbers without a delivered source as unknown', () => {
    expect(segmentAnswer('See [7] and [0].', known)).toEqual([
      { type: 'text', text: 'See ' },
      { type: 'citation', raw: '[7]', refs: [{ n: 7, known: false }] },
      { type: 'text', text: ' and ' },
      { type: 'citation', raw: '[0]', refs: [{ n: 0, known: false }] },
      { type: 'text', text: '.' },
    ]);
  });

  it('handles lists of numbers, mixed known and unknown, with spaces', () => {
    expect(segmentAnswer('Both[1, 3,9 ]', known)).toEqual([
      { type: 'text', text: 'Both' },
      {
        type: 'citation',
        raw: '[1, 3,9 ]',
        refs: [
          { n: 1, known: true },
          { n: 3, known: true },
          { n: 9, known: false },
        ],
      },
    ]);
  });

  it('treats everything as unknown when no sources were delivered', () => {
    expect(segmentAnswer('[1]', new Set())).toEqual([
      { type: 'citation', raw: '[1]', refs: [{ n: 1, known: false }] },
    ]);
  });

  it.each(['[1-2]', '[a]', '[1.5]', '[]', '[1,]', 'array[i]'])('keeps %s as text', (value) => {
    expect(segmentAnswer(value, known)).toEqual([{ type: 'text', text: value }]);
  });

  it('keeps an incomplete citation at the end of a streaming answer as text', () => {
    expect(segmentAnswer('Answer [1', known)).toEqual([{ type: 'text', text: 'Answer [1' }]);
  });

  it('keeps markup as text (rendered by interpolation)', () => {
    expect(segmentAnswer('<img src=x onerror=alert(1)> [1]', known)[0]).toEqual({
      type: 'text',
      text: '<img src=x onerror=alert(1)> ',
    });
  });
});
