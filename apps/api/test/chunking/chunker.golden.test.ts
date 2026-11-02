import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chunkText, type ChunkingOptions } from '../../src/modules/chunking/chunker.js';
import { normalizeText } from '../../src/modules/ingestion/normalize.js';
import { expectChunkInvariants } from './invariants.js';

/**
 * Golden test: makes unintended changes of the chunking behaviour visible in review.
 * After an *intended* change, regenerate the expected output with
 * `UPDATE_GOLDEN=1 pnpm --filter @raglab/api exec vitest run test/chunking/chunker.golden.test.ts`
 * and review the diff of `sample.expected.json`.
 */
const fixture = (name: string) => new URL(`../fixtures/chunking/${name}`, import.meta.url);

const OPTIONS: ChunkingOptions = { targetSize: 300, overlap: 60, format: 'markdown' };

describe('chunkText – golden output', () => {
  it('matches the checked-in chunks of sample.md', () => {
    const text = normalizeText(readFileSync(fixture('sample.md'), 'utf8'));
    const chunks = chunkText(text, OPTIONS);
    expectChunkInvariants(text, chunks, OPTIONS);

    const actual = `${JSON.stringify({ options: OPTIONS, chunks }, null, 2)}\n`;
    if (process.env['UPDATE_GOLDEN'] === '1') {
      writeFileSync(fixture('sample.expected.json'), actual);
    }
    expect(actual).toBe(readFileSync(fixture('sample.expected.json'), 'utf8'));
  });
});
