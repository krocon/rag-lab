import {
  findCut,
  isWordEnd,
  isWordStart,
  skipWhitespace,
  startsSentence,
  trimEnd,
} from './boundaries.js';
import { splitMarkdownSections } from './markdown-sections.js';

export type ChunkingFormat = 'markdown' | 'text';

export interface ChunkingOptions {
  /** Maximum chunk length in UTF-16 code units (`CHUNK_SIZE`), overlap included. */
  targetSize: number;
  /** Maximum overlap with the preceding chunk in UTF-16 code units (`CHUNK_OVERLAP`). */
  overlap: number;
  format: ChunkingFormat;
}

export interface ChunkDraft {
  /** 0-based, without gaps. */
  chunkIndex: number;
  /** Exactly `text.slice(startOffset, endOffset)`; never starts or ends with whitespace. */
  content: string;
  /** Offsets in UTF-16 code units of the normalised text (`String.prototype.slice`). */
  startOffset: number;
  endOffset: number;
  /** `content.length` (UTF-16 code units). */
  charCount: number;
  /** ≈ `charCount / 4`, rounded up – informative only, no model tokenizer. */
  tokenEstimate: number;
  /** Enclosing Markdown headings, outermost first; `[]` for plain text. */
  headingPath: string[];
  /**
   * Length of the leading part repeated from the preceding chunk (`0` for the first chunk of a
   * heading section). `content.slice(overlapChars)` – after leading whitespace – is new text.
   */
  overlapChars: number;
}

interface Section {
  start: number;
  end: number;
  /** End of the (last) heading line; the first chunk of a section is not cut before it. */
  bodyStart: number;
  headingPath: string[];
}

/** Maps a document MIME type to the chunking format. */
export function chunkingFormatFor(mimeType: string): ChunkingFormat {
  return mimeType === 'text/markdown' ? 'markdown' : 'text';
}

/**
 * Splits a (normalised) text into chunks – deterministic, pure, without I/O.
 * Rules and guarantees: docs/adr/0002-rag-pipeline.md §2.
 *
 * 1. Markdown is split into heading sections first; chunks never span two sections. A section
 *    that consists of its heading line only is merged into a directly following, deeper section
 *    (so `# Guide` + `## Install` do not yield a heading-only chunk), and the first chunk of a
 *    section is not cut directly after its heading line if a later line, sentence or paragraph
 *    end fits.
 * 2. Within a section, text is packed greedily: as long as the rest fits into the budget it
 *    becomes one chunk; otherwise the chunk is cut at the last paragraph end within the budget,
 *    else the last sentence end, line end, word end – and only for a word longer than the budget
 *    hard (never between the halves of a surrogate pair).
 * 3. Every chunk after the first of a section starts with an overlap of at most `overlap` code
 *    units taken from the end of the previous chunk, starting at a word start – preferably a
 *    sentence start if that keeps at least half of the possible overlap. The overlap shrinks so
 *    that the next word still fits: overlap never causes a hard cut.
 * 4. Chunk length (overlap included) ≤ `targetSize`.
 */
export function chunkText(text: string, options: ChunkingOptions): ChunkDraft[] {
  assertValidOptions(options);
  const { targetSize, overlap } = options;
  const drafts: ChunkDraft[] = [];

  for (const section of sectionsOf(text, options.format)) {
    const sectionEnd = trimEnd(text, section.start, section.end);
    let position = skipWhitespace(text, section.start, sectionEnd);
    let previousCoreStart: number | undefined;

    while (position < sectionEnd) {
      let start = position;
      if (previousCoreStart !== undefined && overlap > 0) {
        const maxOverlap = Math.min(
          overlap,
          targetSize - firstWordLength(text, position, sectionEnd, targetSize),
        );
        if (maxOverlap > 0) {
          start = overlapStart(
            text,
            Math.max(position - maxOverlap, previousCoreStart + 1),
            position,
            maxOverlap,
          );
        }
      }

      const budget = targetSize - (position - start);
      // The first chunk of a section is not cut right after its heading line(s).
      const minCut = previousCoreStart === undefined ? section.bodyStart + 1 : position + 1;
      const end =
        sectionEnd - position <= budget
          ? sectionEnd
          : findCut(text, position, budget, minCut).position;
      const content = text.slice(start, end);
      drafts.push({
        chunkIndex: drafts.length,
        content,
        startOffset: start,
        endOffset: end,
        charCount: content.length,
        tokenEstimate: Math.ceil(content.length / 4),
        headingPath: [...section.headingPath],
        overlapChars: position - start,
      });

      previousCoreStart = position;
      position = skipWhitespace(text, end, sectionEnd);
    }
  }
  return drafts;
}

function assertValidOptions({ targetSize, overlap, format }: ChunkingOptions): void {
  if (!Number.isInteger(targetSize) || targetSize < 1) {
    throw new RangeError('targetSize must be a positive integer');
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= targetSize) {
    throw new RangeError('overlap must be an integer >= 0 and smaller than targetSize');
  }
  if (format !== 'markdown' && format !== 'text') {
    throw new RangeError('format must be "markdown" or "text"');
  }
}

function sectionsOf(text: string, format: ChunkingFormat): Section[] {
  if (format === 'text') {
    return [{ start: 0, end: text.length, bodyStart: 0, headingPath: [] }];
  }
  const sections = splitMarkdownSections(text);
  const merged: Section[] = [];
  let carriedStart: number | undefined;
  sections.forEach((section, index) => {
    const start = carriedStart ?? section.start;
    const next = sections[index + 1];
    if (section.headingOnly && next !== undefined && next.level > section.level) {
      carriedStart = start;
      return;
    }
    carriedStart = undefined;
    merged.push({
      start,
      end: section.end,
      bodyStart: section.bodyStart,
      headingPath: section.headingPath,
    });
  });
  return merged;
}

/**
 * Length of the word starting at `from`; `Infinity` if it is longer than `targetSize` (it will be
 * cut hard anyway, so no overlap is kept).
 */
function firstWordLength(text: string, from: number, sectionEnd: number, targetSize: number) {
  const limit = Math.min(sectionEnd, from + targetSize);
  for (let position = from + 1; position <= limit; position++) {
    if (isWordEnd(text, position)) {
      return position - from;
    }
  }
  return sectionEnd - from <= targetSize ? sectionEnd - from : Number.POSITIVE_INFINITY;
}

/**
 * Start of the overlap in `[from, position)`: the earliest sentence start that keeps at least half
 * of `maxOverlap`, else the earliest word start; `position` (no overlap) if there is none.
 */
function overlapStart(text: string, from: number, position: number, maxOverlap: number): number {
  let firstWordStart: number | undefined;
  for (let candidate = from; candidate < position; candidate++) {
    if (!isWordStart(text, candidate)) {
      continue;
    }
    firstWordStart ??= candidate;
    if (position - candidate < maxOverlap / 2) {
      break;
    }
    if (startsSentence(text, candidate)) {
      return candidate;
    }
  }
  return firstWordStart ?? position;
}
