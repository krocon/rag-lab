import { describe, expect, it } from 'vitest';
import {
  embeddingHeader,
  embeddingText,
  MAX_EMBEDDING_HEADER_CHARS,
} from '../../src/modules/embeddings/embedding-text.js';

describe('embeddingText', () => {
  it('embeds documents without a path unchanged (no header)', () => {
    expect(embeddingHeader({ path: null, symbol: 'class X' })).toBeNull();
    expect(embeddingText({ path: null, content: 'Hello' })).toBe('Hello');
  });

  it('prefixes code chunks with file and symbol', () => {
    expect(
      embeddingText({
        path: 'packages/table/src/tree.ts',
        content: 'export class TreeFactory {}',
        symbol: 'class TreeFactory',
        headingPath: ['packages/table/src/tree.ts', 'class TreeFactory'],
      }),
    ).toBe(
      'File: packages/table/src/tree.ts\nSymbol: class TreeFactory\n\nexport class TreeFactory {}',
    );
  });

  it('prefixes Markdown chunks with file and section', () => {
    expect(embeddingHeader({ path: 'docs/guide.md', headingPath: ['Guide', 'Tree table'] })).toBe(
      'File: docs/guide.md\nSection: Guide > Tree table\n\n',
    );
    expect(embeddingHeader({ path: 'a.ts', headingPath: ['a.ts'] })).toBe('File: a.ts\n\n');
  });

  it('limits the header length', () => {
    const header = embeddingHeader({ path: 'a.ts', symbol: 'x'.repeat(1000) }) ?? '';
    expect(Array.from(header).length).toBe(MAX_EMBEDDING_HEADER_CHARS + 2);
  });
});
