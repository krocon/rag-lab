import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  chunkText,
  chunkingFormatFor,
  type ChunkingOptions,
} from '../../src/modules/chunking/chunker.js';
import { normalizeText } from '../../src/modules/ingestion/normalize.js';
import { expectChunkInvariants, expectCodeInvariants } from './invariants.js';

const fixture = (name: string) => new URL(`../fixtures/chunking/code/${name}`, import.meta.url);

/**
 * Golden tests for source code (ADR 0004). After an intended change regenerate with
 * `UPDATE_GOLDEN=1 pnpm --filter @raglab/api exec vitest run test/chunking/chunker.code.test.ts`
 * and review the diff.
 */
describe.each([
  { file: 'tree-table.ts.txt', language: 'typescript' },
  { file: 'TreeView.vue', language: 'vue' },
])('chunkText – golden output of $file', ({ file, language }) => {
  const options: ChunkingOptions = { targetSize: 600, overlap: 120, format: 'code', language };

  it('matches the checked-in chunks', () => {
    const text = normalizeText(readFileSync(fixture(file), 'utf8'));
    const chunks = chunkText(text, options);
    expectChunkInvariants(text, chunks, options);
    expectCodeInvariants(text, chunks, options);

    const actual = `${JSON.stringify({ options, chunks }, null, 2)}\n`;
    const expectedFile = fixture(`${file}.expected.json`);
    if (process.env['UPDATE_GOLDEN'] === '1') {
      writeFileSync(expectedFile, actual);
    }
    expect(actual).toBe(readFileSync(expectedFile, 'utf8'));
  });
});

describe('chunkText – source code', () => {
  const ts = normalizeText(readFileSync(fixture('tree-table.ts.txt'), 'utf8'));
  const code = (targetSize: number, overlap: number): ChunkingOptions => ({
    targetSize,
    overlap,
    format: 'code',
    language: 'typescript',
  });

  it('keeps a declaration that fits into one chunk whole, with its doc comment', () => {
    const chunks = chunkText(ts, code(2000, 0));
    const factory = chunks.find((chunk) =>
      chunk.content.includes('export function createTreeTableModel'),
    );
    expect(factory?.content).toContain('/** Builds a model');
    expect(factory?.content.endsWith('return new TreeTableModel(roots);\n}')).toBe(true);
  });

  it('keeps a multi-line decorator with its class', () => {
    const chunks = chunkText(ts, code(600, 0));
    const decorated = chunks.find((chunk) => chunk.content.includes('@Injectable({'));
    expect(decorated?.content).toContain('export class TreeTableModel');
    expect(decorated?.symbol).toBe('class TreeTableModel');
  });

  it('merges small declarations into one chunk and lists their symbols', () => {
    const chunks = chunkText(ts, code(400, 0));
    const first = chunks.find((chunk) => chunk.content.includes('export type RowId'));
    expect(first?.symbol).toContain('type RowId');
    expect(first?.symbol).toContain('interface TreeRow');
    expect(first?.headingPath).toEqual([first?.symbol]);
  });

  it('gives every part of a long class the class as symbol and correct line numbers', () => {
    const options = code(300, 60);
    const chunks = chunkText(ts, options);
    expectChunkInvariants(ts, chunks, options);
    expectCodeInvariants(ts, chunks, options);
    const parts = chunks.filter((chunk) => chunk.content.includes('this.find('));
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) {
      expect(part.symbol).toContain('class TreeTableModel');
    }
    const lines = ts.split('\n');
    for (const chunk of chunks) {
      expect(lines[chunk.startLine - 1]).toContain(chunk.content.split('\n')[0] ?? '');
    }
  });

  it('cuts a minified line at word ends, then hard (defined fallback)', () => {
    const text = `const a = 1;\n${'x();'.repeat(100)} ${'y'.repeat(500)}\n`;
    const options: ChunkingOptions = {
      targetSize: 120,
      overlap: 20,
      format: 'code',
      language: 'javascript',
    };
    const chunks = chunkText(text, options);
    expectChunkInvariants(text, chunks, options);
    expectCodeInvariants(text, chunks, options);
    expect(chunks.length).toBeGreaterThan(4);
  });

  it('maps MIME types to the code format', () => {
    expect(chunkingFormatFor('text/markdown')).toBe('markdown');
    expect(chunkingFormatFor('text/plain')).toBe('text');
    expect(chunkingFormatFor('text/typescript')).toBe('code');
    expect(chunkingFormatFor('text/html')).toBe('code');
  });

  it('rejects unknown formats', () => {
    expect(() => chunkText('x', { targetSize: 10, overlap: 0, format: 'pdf' as never })).toThrow(
      RangeError,
    );
  });
});

describe('chunkText – Markdown code blocks', () => {
  it('does not cut inside a fenced block that fits into one chunk', () => {
    const block = ['```ts', 'const tree = createTreeTableModel(rows);', 'tree.toggle(1);', '```'].join(
      '\n',
    );
    const text = `Intro sentence one. Intro sentence two.\n\n${block}\n\nAfter the block.`;
    const options: ChunkingOptions = { targetSize: 100, overlap: 0, format: 'markdown' };
    const chunks = chunkText(text, options);
    expectChunkInvariants(text, chunks, options);
    expect(chunks.some((chunk) => chunk.content.includes(block))).toBe(true);
  });

  it('cuts a block that is too long for one chunk at line ends', () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line${index}();`);
    const text = `Text.\n\n\`\`\`js\n${lines.join('\n')}\n\`\`\`\n`;
    const options: ChunkingOptions = { targetSize: 120, overlap: 20, format: 'markdown' };
    const chunks = chunkText(text, options);
    expectChunkInvariants(text, chunks, options);
    expect(chunks.length).toBeGreaterThan(2);
  });
});
