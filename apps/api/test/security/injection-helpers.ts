import { readFileSync } from 'node:fs';
import { expect } from 'vitest';

/** A document written to break out of its source block (see the fixture for every variant). */
export const INJECTION_DOCUMENT = readFileSync(
  new URL('../fixtures/security/prompt-injection.md', import.meta.url),
  'utf8',
);

/** Raw, un-neutralised source tag starts (opening or closing) in a text. */
const RAW_SOURCE_TAG = /<\s*\/?\s*source(?![\w-])/gi;

/**
 * Asserts that a user message consists of exactly `count` well-formed source blocks followed by
 * the question, and that no other source delimiter occurs anywhere. Returns the block bodies.
 */
export function sourceBlockBodies(userMessage: string, count: number): string[] {
  const blockPattern = /<source id="(\d+)"[^>\n]*>\n([\s\S]*?)\n<\/source>/g;
  const bodies: string[] = [];
  const ids: string[] = [];
  for (const match of userMessage.matchAll(blockPattern)) {
    ids.push(match[1] ?? '');
    bodies.push(match[2] ?? '');
  }
  expect(ids).toEqual(Array.from({ length: count }, (_, index) => String(index + 1)));
  // Every raw tag in the message belongs to one of the blocks: 2 per block, nothing else.
  expect(userMessage.match(RAW_SOURCE_TAG) ?? []).toHaveLength(count * 2);
  for (const body of bodies) {
    expect(body).not.toMatch(RAW_SOURCE_TAG);
  }
  return bodies;
}
