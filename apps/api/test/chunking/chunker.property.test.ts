import { describe, expect, it } from 'vitest';
import {
  chunkText,
  type ChunkingFormat,
  type ChunkingOptions,
} from '../../src/modules/chunking/chunker.js';
import { expectChunkInvariants } from './invariants.js';

/**
 * Property-based tests with a small seeded generator (mulberry32) instead of a dependency such as
 * fast-check: the invariants need random *texts* only, and a fixed seed keeps runs reproducible.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'lorem',
  'ipsum',
  'RAG',
  'pgvector',
  'Größe',
  'naïve',
  'Übermaß',
  'emoji😀',
  '👩‍💻',
  'e.g.',
  '1.5',
  'x',
  '"quoted."',
  '(aside!)',
  'https://example.com/a.b?c=d',
  '#hashtag',
];
const SEPARATORS = [' ', ' ', ' ', ' ', '  ', '\t', '\n', '\n\n', ' \n\n'];
const TERMINATORS = ['', '', '', '.', '!', '?', '.'];

function generateText(random: () => number): string {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const word = (): string => {
    const roll = random();
    if (roll < 0.03) {
      // Occasionally a very long word (forces hard cuts), sometimes with surrogate pairs.
      const unit = random() < 0.5 ? 'z' : '😀';
      return unit.repeat(1 + Math.floor(random() * 200));
    }
    if (roll < 0.15) {
      return 'abcdefghijklmnopqrstuvwxyz'.slice(0, 1 + Math.floor(random() * 26));
    }
    return pick(WORDS);
  };

  const parts: string[] = [];
  const blocks = 1 + Math.floor(random() * 25);
  for (let block = 0; block < blocks; block++) {
    const roll = random();
    if (roll < 0.15) {
      parts.push(`${'#'.repeat(1 + Math.floor(random() * 6))} ${word()} ${word()}\n`);
    } else if (roll < 0.22) {
      const fence = random() < 0.5 ? '```' : '~~~';
      parts.push(`${fence}\n# inside ${word()}\n${word()} ${word()}\n${fence}\n`);
    } else {
      const words = 1 + Math.floor(random() * 60);
      for (let i = 0; i < words; i++) {
        parts.push(word() + pick(TERMINATORS) + pick(SEPARATORS));
      }
    }
    parts.push(pick(['\n', '\n\n', '\n\n', '']));
  }
  return parts.join('');
}

function generateOptions(random: () => number): ChunkingOptions {
  const targetSize = 1 + Math.floor(random() * (random() < 0.2 ? 20 : 400));
  const overlap = random() < 0.2 ? 0 : Math.floor(random() * targetSize);
  const format: ChunkingFormat = random() < 0.5 ? 'markdown' : 'text';
  return { targetSize, overlap, format };
}

describe('chunkText – properties (seeded)', () => {
  const random = mulberry32(20261102);
  const cases = Array.from({ length: 400 }, (_, index) => ({
    index,
    text: generateText(random),
    options: generateOptions(random),
  }));

  it.each(cases)('case $index satisfies every invariant', ({ text, options }) => {
    const chunks = chunkText(text, options);
    expectChunkInvariants(text, chunks, options);
    // Determinism: same input and options → identical output.
    expect(chunkText(text, options)).toEqual(chunks);
  });

  it('produces chunks for every generated non-blank text', () => {
    for (const { text, options } of cases) {
      expect(chunkText(text, options).length > 0).toBe(text.trim().length > 0);
    }
  });
});
