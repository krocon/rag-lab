import {
  formFromParams,
  paramsFromForm,
  requestFromParams,
  validateForm,
} from './playground-query';
import { chatContextStatus, scoreBarPercent } from './playground-results';
import { playgroundResult } from '../../../testing/fixtures';

const ID = '0190a8c4-0000-7000-8000-000000000001';

describe('playground query parameters', () => {
  it('round-trips form → URL → request', () => {
    const params = paramsFromForm({
      collectionId: ID,
      query: '  a question  ',
      topK: '05',
      minScore: ' 0.25 ',
      includePrompt: true,
    });
    expect(params).toEqual({
      collection: ID,
      q: 'a question',
      topK: '5',
      minScore: '0.25',
      prompt: '1',
    });

    const request = requestFromParams({
      collection: params['collection'] ?? undefined,
      q: params['q'] ?? undefined,
      topK: params['topK'] ?? undefined,
      minScore: params['minScore'] ?? undefined,
      prompt: params['prompt'] ?? undefined,
    });
    expect(request).toEqual({
      collectionId: ID,
      query: 'a question',
      topK: 5,
      minScore: 0.25,
      includePrompt: true,
    });
  });

  it('leaves out empty optional values', () => {
    expect(
      paramsFromForm({
        collectionId: ID,
        query: 'q',
        topK: '',
        minScore: '',
        includePrompt: false,
      }),
    ).toEqual({ collection: ID, q: 'q', topK: null, minScore: null, prompt: null });
    expect(requestFromParams({ collection: ID, q: 'q' })).toEqual({ collectionId: ID, query: 'q' });
  });

  it('describes no search without collection or query, or with invalid values', () => {
    expect(requestFromParams({})).toBeUndefined();
    expect(requestFromParams({ collection: ID })).toBeUndefined();
    expect(requestFromParams({ collection: ID, q: '   ' })).toBeUndefined();
    expect(requestFromParams({ collection: ID, q: 'q', topK: '1.5' })).toBeUndefined();
    expect(requestFromParams({ collection: ID, q: 'q', minScore: 'x' })).toBeUndefined();
  });

  it.each([
    ['0', 'topK'],
    ['101', 'topK'],
    ['-3', 'topK'],
  ])('rejects topK %s', (topK, key) => {
    const errors = validateForm({ ...formFromParams({ collection: ID, q: 'q' }), topK });
    expect(Object.keys(errors)).toEqual([key]);
  });

  it('accepts the boundaries of topK and minScore', () => {
    for (const [topK, minScore] of [
      ['1', '-1'],
      ['100', '1'],
    ] as const) {
      expect(
        validateForm({ ...formFromParams({ collection: ID, q: 'q' }), topK, minScore }),
      ).toEqual({});
    }
  });

  it('checks the query length only when MAX_QUERY_CHARS is known', () => {
    const form = formFromParams({ collection: ID, q: 'x'.repeat(11) });
    expect(validateForm(form)).toEqual({});
    expect(validateForm(form, 10).query).toBe(
      'The query must not be longer than 10 characters (it has 11).',
    );
  });
});

describe('result helpers', () => {
  it('derives the chat context status, preferring "below minScore" over the budget', () => {
    expect(chatContextStatus(playgroundResult(1))).toBe('included');
    expect(chatContextStatus(playgroundResult(1, { includedInChatContext: false }))).toBe(
      'outside-budget',
    );
    expect(
      chatContextStatus(playgroundResult(1, { includedInChatContext: false, belowMinScore: true })),
    ).toBe('below-min-score');
  });

  it('maps scores to a 0..100 % bar', () => {
    expect(scoreBarPercent(0.8734)).toBe(87.3);
    expect(scoreBarPercent(1)).toBe(100);
    expect(scoreBarPercent(-0.2)).toBe(0);
  });
});
