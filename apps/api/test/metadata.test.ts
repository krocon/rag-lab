import { describe, expect, it } from 'vitest';
import { extractMetadata, MAX_TITLE_LENGTH } from '../src/modules/ingestion/metadata.js';

const md = (text: string) => extractMetadata(text, 'text/markdown');

describe('extractMetadata', () => {
  it('takes the first ATX heading of any level as title', () => {
    expect(md('Intro text\n\n## Setup ##\n\n# Later')).toEqual({ title: 'Setup' });
    expect(md('#   Spaced title   \nbody')).toEqual({ title: 'Spaced title' });
  });

  it('ignores headings in fenced code blocks', () => {
    expect(md('```bash\n# comment\n```\n# Real')).toEqual({ title: 'Real' });
    expect(md('~~~\n# a\n```\n# b\n~~~\n# Real')).toEqual({ title: 'Real' });
  });

  it('ignores YAML front matter', () => {
    expect(md('---\n# yaml comment\ntitle: x\n---\n# Real')).toEqual({ title: 'Real' });
  });

  it('requires a space after the hashes and a non-empty text', () => {
    expect(md('#hashtag\n#\n# ')).toEqual({});
  });

  it('limits the title length', () => {
    const { title } = md(`# ${'x'.repeat(500)}`);
    expect(title).toHaveLength(MAX_TITLE_LENGTH);
  });

  it('extracts nothing from plain text', () => {
    expect(extractMetadata('# Not a heading in .txt', 'text/plain')).toEqual({});
  });
});
