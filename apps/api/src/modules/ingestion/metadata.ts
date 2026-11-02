import type { DocumentMetadataFields } from '@raglab/shared';
import { findAtxHeadings } from '../chunking/markdown-sections.js';

/** Maximum length of an extracted title in characters. */
export const MAX_TITLE_LENGTH = 200;

/**
 * Derives document metadata from the normalised text. Currently only `title`: the text of the
 * first ATX heading (`#` … `######`) of a Markdown document, ignoring fenced code blocks and a
 * leading YAML front matter block. Setext headings (`===` underlines) are not recognised.
 * Plain text documents get no title. Heading detection is shared with the chunker
 * (`chunking/markdown-sections.ts`), so title and heading paths agree.
 */
export function extractMetadata(content: string, mimeType: string): DocumentMetadataFields {
  if (mimeType !== 'text/markdown') {
    return {};
  }
  const heading = findAtxHeadings(content)[0];
  return heading === undefined
    ? {}
    : { title: Array.from(heading.text).slice(0, MAX_TITLE_LENGTH).join('') };
}
