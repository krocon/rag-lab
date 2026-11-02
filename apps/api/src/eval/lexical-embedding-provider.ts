import type { EmbeddingProvider } from '../modules/embeddings/embedding-provider.js';

/**
 * Deterministic lexical "embedding": a hashed bag of words (feature hashing).
 *
 * NOT a semantic model. Texts are only similar if they share words, so it measures the wiring of
 * the pipeline (upload → chunking → embedding → pgvector → ranking → metrics), not the quality of
 * a real embedding model. Used by the CI smoke test and by `pnpm eval --baseline` as a
 * reproducible baseline that needs no Ollama (docs/evaluation.md).
 *
 * Algorithm: lower-case word tokens (letters/digits), English stop words removed, a plural "s"
 * stripped; each token is hashed (FNV-1a, 32 bit) to a bucket with a sign from a second hash
 * (reduces the bias of collisions); weight `1 + ln(tf)`; plus a small character-trigram part (see
 * {@link lexicalVector}); L2-normalised. A text without tokens gets a fixed unit vector (a zero
 * vector has no cosine distance).
 */
export const LEXICAL_PROVIDER_ID = 'lexical-baseline';
export const LEXICAL_MODEL = 'hashed-bag-of-words-v1';

const STOP_WORDS = new Set(
  (
    'a an and are as at be but by can do does for from how i if in into is it its me my no not of ' +
    'on or our should so than that the their them then there these they this to was we what when ' +
    'where which who why will with you your'
  ).split(' '),
);

/** FNV-1a 32-bit hash. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function lexicalTokens(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words
    .filter((word) => !STOP_WORDS.has(word))
    .map((word) =>
      word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word,
    );
}

/** Share of the cosine similarity that comes from whole words (the rest: character trigrams). */
const WORD_WEIGHT = 0.9;

/** Hashed, signed counts with weight `1 + ln(tf)`, L2-normalised (all zeros without features). */
function hashedFeatures(features: readonly string[], dimensions: number): number[] {
  const counts = new Map<string, number>();
  for (const feature of features) {
    counts.set(feature, (counts.get(feature) ?? 0) + 1);
  }
  const vector = new Array<number>(dimensions).fill(0);
  for (const [feature, count] of counts) {
    const bucket = fnv1a(feature) % dimensions;
    const sign = fnv1a(`${feature}#sign`) & 1 ? 1 : -1;
    vector[bucket] = (vector[bucket] ?? 0) + sign * (1 + Math.log(count));
  }
  const norm = Math.hypot(...vector);
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

/** Character trigrams of the token stream (`"dough rise"` → `"dou"`, `"oug"`, …, `"h r"`, …). */
export function characterTrigrams(tokens: readonly string[]): string[] {
  const text = tokens.join(' ');
  const trigrams: string[] = [];
  for (let index = 0; index + 3 <= text.length; index++) {
    trigrams.push(text.slice(index, index + 3));
  }
  return trigrams;
}

/**
 * Words fill the first 5/6 of the dimensions, character trigrams the rest, so the cosine
 * similarity is exactly `0.9 · cos(words) + 0.1 · cos(trigrams)`. The small trigram part avoids
 * exact ties between texts without a common word (a tie would be broken by random document ids
 * and make runs irreproducible).
 */
export function lexicalVector(text: string, dimensions: number): number[] {
  if (!Number.isInteger(dimensions) || dimensions < 6) {
    throw new RangeError('the lexical baseline needs at least 6 dimensions');
  }
  const tokens = lexicalTokens(text);
  const trigramDimensions = Math.floor(dimensions / 6);
  const words = hashedFeatures(tokens, dimensions - trigramDimensions);
  const trigrams = hashedFeatures(characterTrigrams(tokens), trigramDimensions);
  const vector = [
    ...words.map((value) => value * Math.sqrt(WORD_WEIGHT)),
    ...trigrams.map((value) => value * Math.sqrt(1 - WORD_WEIGHT)),
  ];
  const norm = Math.hypot(...vector);
  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }
  return vector.map((value) => value / norm);
}

export function createLexicalEmbeddingProvider(dimensions: number): EmbeddingProvider {
  return {
    id: LEXICAL_PROVIDER_ID,
    model: LEXICAL_MODEL,
    dimensions,
    async embed(texts, signal) {
      signal?.throwIfAborted();
      return texts.map((text) => lexicalVector(text, dimensions));
    },
    async checkStatus() {
      return { reachable: true, modelAvailable: true };
    },
  };
}
