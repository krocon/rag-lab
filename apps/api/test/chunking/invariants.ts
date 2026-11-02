import { expect } from 'vitest';
import type { ChunkDraft, ChunkingOptions } from '../../src/modules/chunking/chunker.js';

const WHITESPACE = /\s/;
const isWs = (char: string | undefined) => char !== undefined && WHITESPACE.test(char);

/** Length of the whitespace-delimited word that contains `position`. */
function wordLengthAt(text: string, position: number): number {
  let start = position;
  while (start > 0 && !isWs(text[start - 1])) {
    start--;
  }
  let end = position;
  while (end < text.length && !isWs(text[end])) {
    end++;
  }
  return end - start;
}

/**
 * Asserts every documented guarantee of `chunkText` (docs/adr/0002-rag-pipeline.md §2) for one
 * input. Used by the table, property and golden tests.
 */
export function expectChunkInvariants(
  text: string,
  chunks: ChunkDraft[],
  { targetSize, overlap }: Pick<ChunkingOptions, 'targetSize' | 'overlap'>,
): void {
  let rebuilt = '';
  let cursor = 0;
  chunks.forEach((chunk, index) => {
    const where = `chunk ${index}`;
    // Index without gaps; content is exactly the offset range; no blank or untrimmed chunks.
    expect(chunk.chunkIndex, where).toBe(index);
    expect(chunk.content, where).toBe(text.slice(chunk.startOffset, chunk.endOffset));
    expect(chunk.content.length, where).toBeGreaterThan(0);
    expect(chunk.content.trim(), where).toBe(chunk.content);
    expect(chunk.charCount, where).toBe(chunk.content.length);
    expect(chunk.tokenEstimate, where).toBe(Math.ceil(chunk.charCount / 4));

    // Size: only a surrogate pair with targetSize 1 may exceed the target (by one code unit).
    expect(chunk.charCount, where).toBeLessThanOrEqual(Math.max(targetSize, 2));
    if (targetSize > 1) {
      expect(chunk.charCount, where).toBeLessThanOrEqual(targetSize);
    }

    // Overlap: bounded, only within the previous chunk, starting at a word start.
    expect(chunk.overlapChars, where).toBeGreaterThanOrEqual(0);
    expect(chunk.overlapChars, where).toBeLessThanOrEqual(overlap);
    const previous = chunks[index - 1];
    if (previous) {
      expect(chunk.startOffset, where).toBeGreaterThan(previous.startOffset);
      expect(chunk.endOffset, where).toBeGreaterThan(previous.endOffset);
      if (chunk.overlapChars > 0) {
        expect(chunk.startOffset, where).toBeLessThan(previous.endOffset);
      } else {
        expect(chunk.startOffset, where).toBeGreaterThanOrEqual(previous.endOffset);
      }
    } else {
      expect(chunk.overlapChars, where).toBe(0);
    }

    // Reconstruction: whitespace gap + new part of every chunk, in order, rebuilds the text.
    const coreStart = chunk.startOffset + chunk.overlapChars;
    const gap = text.slice(cursor, coreStart);
    expect(gap.trim(), `${where}: text between chunks`).toBe('');
    rebuilt += gap + chunk.content.slice(chunk.overlapChars);
    cursor = chunk.endOffset;

    // Word boundaries: a chunk may only start/end inside a word that is longer than targetSize.
    const startsInWord = chunk.startOffset > 0 && !isWs(text[chunk.startOffset - 1]);
    if (startsInWord) {
      expect(chunk.overlapChars, `${where}: overlap starts mid-word`).toBe(0);
      expect(wordLengthAt(text, chunk.startOffset), `${where}: starts mid-word`).toBeGreaterThan(
        targetSize,
      );
    }
    const endsInWord = chunk.endOffset < text.length && !isWs(text[chunk.endOffset]);
    if (endsInWord) {
      expect(wordLengthAt(text, chunk.endOffset - 1), `${where}: ends mid-word`).toBeGreaterThan(
        targetSize,
      );
    }
  });
  const rest = text.slice(cursor);
  expect(rest.trim(), 'text after the last chunk').toBe('');
  expect(rebuilt + rest).toBe(text);
}
