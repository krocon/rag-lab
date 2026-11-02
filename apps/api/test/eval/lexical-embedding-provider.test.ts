import { describe, expect, it } from 'vitest';
import {
  characterTrigrams,
  createLexicalEmbeddingProvider,
  lexicalTokens,
  lexicalVector,
} from '../../src/eval/lexical-embedding-provider.js';
import { cosineDistance } from '../fakes.js';

describe('lexical baseline embedding', () => {
  it('tokenises lower-case words without stop words and strips a plural s', () => {
    expect(lexicalTokens('How do I feed the Starters? Glass jars, 50 g!')).toEqual([
      'feed',
      'starter',
      'glass',
      'jar',
      '50',
      'g',
    ]);
    expect(characterTrigrams(['ab', 'cd'])).toEqual(['ab ', 'b c', ' cd']);
  });

  it('is deterministic and L2-normalised', () => {
    const a = lexicalVector('Feeding the sourdough starter', 768);
    expect(lexicalVector('Feeding the sourdough starter', 768)).toEqual(a);
    expect(a).toHaveLength(768);
    expect(Math.hypot(...a)).toBeCloseTo(1, 10);
  });

  it('puts texts with shared words closer than unrelated texts', () => {
    const query = lexicalVector('how often to feed a sourdough starter', 768);
    const related = lexicalVector('Feed the sourdough starter once a week in the fridge.', 768);
    const unrelated = lexicalVector('Inverters convert direct current from solar panels.', 768);
    expect(cosineDistance(query, related)).toBeLessThan(cosineDistance(query, unrelated));
  });

  it('avoids exact ties between texts without a common word', () => {
    const query = lexicalVector('telescope aperture', 768);
    const first = cosineDistance(query, lexicalVector('compost heap moisture', 768));
    const second = cosineDistance(query, lexicalVector('espresso grind size', 768));
    expect(first).not.toBe(second);
  });

  it('returns a unit vector for text without tokens', () => {
    const vector = lexicalVector('the of and', 12);
    expect(vector[0]).toBe(1);
    expect(Math.hypot(...vector)).toBe(1);
  });

  it('rejects too few dimensions', () => {
    expect(() => lexicalVector('text', 4)).toThrow(RangeError);
  });

  it('implements the embedding provider interface', async () => {
    const provider = createLexicalEmbeddingProvider(768);
    expect(provider).toMatchObject({ id: 'lexical-baseline', dimensions: 768 });
    const vectors = await provider.embed(['a text', 'another text']);
    expect(vectors.map((vector) => vector.length)).toEqual([768, 768]);
    await expect(provider.checkStatus()).resolves.toEqual({
      reachable: true,
      modelAvailable: true,
    });
    await expect(provider.embed(['x'], AbortSignal.abort())).rejects.toThrow();
  });
});
