import {
  findCut,
  isWhitespace,
  isWordEnd,
  isWordStart,
  skipWhitespace,
  startsSentence,
  trimEnd,
  type CutOptions,
} from './boundaries.js';
import { splitCodeSections } from './code-sections.js';
import { findFencedBlocks, splitMarkdownSections } from './markdown-sections.js';

export type ChunkingFormat = 'markdown' | 'text' | 'code';

export const CHUNKING_FORMATS: readonly ChunkingFormat[] = ['markdown', 'text', 'code'];

export interface ChunkingOptions {
  /** Maximum chunk length in UTF-16 code units (`CHUNK_SIZE`), overlap included. */
  targetSize: number;
  /** Maximum overlap with the preceding chunk in UTF-16 code units (`CHUNK_OVERLAP`). */
  overlap: number;
  format: ChunkingFormat;
  /** Language for `format: 'code'` (`typescript`, `vue`, …): selects declaration heuristics. */
  language?: string | undefined;
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
  /** 1-based line of `startOffset` and of the last character of the chunk. */
  startLine: number;
  endLine: number;
  /**
   * Source code: the top-level declaration(s) the chunk's new text belongs to
   * (`class TreeFactory`, or up to three names joined by `, `); `null` otherwise.
   */
  symbol: string | null;
}

interface Section {
  start: number;
  end: number;
  /** End of the (last) heading line; the first chunk of a section is not cut before it. */
  bodyStart: number;
  headingPath: string[];
  /** Source code: declarations inside the section (several when small ones were merged). */
  declarations?: { start: number; end: number; symbol: string | null }[];
}

/** Symbols listed in a chunk's `symbol` at most; more are indicated with `, …`. */
const MAX_SYMBOLS_PER_CHUNK = 3;

/** Maps a document MIME type to the chunking format (see `ingestion/file-type.ts`). */
export function chunkingFormatFor(mimeType: string): ChunkingFormat {
  if (mimeType === 'text/markdown') {
    return 'markdown';
  }
  return mimeType === 'text/plain' ? 'text' : 'code';
}

/**
 * Splits a (normalised) text into chunks – deterministic, pure, without I/O.
 * Rules and guarantees: docs/adr/0002-rag-pipeline.md §2, source code: docs/adr/0004-source-import.md.
 *
 * 1. Markdown is split into heading sections first; chunks never span two sections. A section
 *    that consists of its heading line only is merged into a directly following, deeper section
 *    (so `# Guide` + `## Install` do not yield a heading-only chunk), and the first chunk of a
 *    section is not cut directly after its heading line if a later line, sentence or paragraph
 *    end fits. Fenced code blocks that fit into one chunk are not cut if a line, sentence or
 *    paragraph end outside them is available.
 *    Source code is split into top-level declaration sections (`code-sections.ts`); consecutive
 *    sections are merged as long as they fit into one chunk together.
 * 2. Within a section, text is packed greedily: as long as the rest fits into the budget it
 *    becomes one chunk; otherwise the chunk is cut at the last paragraph end within the budget,
 *    else the last sentence end, line end, word end – and only for a word longer than the budget
 *    hard (never between the halves of a surrogate pair). Source code has no sentence level and
 *    is cut at a word end only when a single line is longer than the budget (minified code).
 * 3. Every chunk after the first of a section starts with an overlap of at most `overlap` code
 *    units taken from the end of the previous chunk, starting at a word start – preferably a
 *    sentence start if that keeps at least half of the possible overlap (source code: the first
 *    line start, else no overlap). The overlap shrinks so that the next word still fits: overlap
 *    never causes a hard cut.
 * 4. Chunk length (overlap included) ≤ `targetSize`.
 */
export function chunkText(text: string, options: ChunkingOptions): ChunkDraft[] {
  assertValidOptions(options);
  const { targetSize, overlap, format } = options;
  const isCode = format === 'code';
  const lines = createLineIndex(text);
  const cutOptions: CutOptions = isCode ? { code: true } : {};
  if (format === 'markdown') {
    // Code blocks short enough to stay whole (after a full overlap) are kept together.
    const protectedBlocks = findFencedBlocks(text).filter(
      (block) => block.end - block.start <= targetSize - overlap,
    );
    if (protectedBlocks.length > 0) {
      cutOptions.isProtected = (position) =>
        protectedBlocks.some((block) => position > block.start && position < block.end);
    }
  }
  const drafts: ChunkDraft[] = [];

  for (const section of sectionsOf(text, options)) {
    const sectionEnd = trimEnd(text, section.start, section.end);
    let position = skipWhitespace(text, section.start, sectionEnd);
    let previousCoreStart: number | undefined;

    while (position < sectionEnd) {
      let start = position;
      if (previousCoreStart !== undefined && overlap > 0) {
        // Source code: the whole next line must still fit, else the overlap would force a
        // mid-line cut; prose: the next word.
        const firstUnit = isCode
          ? firstLineLength(text, position, sectionEnd, targetSize)
          : firstWordLength(text, position, sectionEnd, targetSize);
        const maxOverlap = Math.min(overlap, targetSize - firstUnit);
        if (maxOverlap > 0) {
          const from = Math.max(position - maxOverlap, previousCoreStart + 1);
          start = isCode
            ? lineOverlapStart(text, from, position)
            : overlapStart(text, from, position, maxOverlap);
        }
      }

      const budget = targetSize - (position - start);
      // The first chunk of a section is not cut right after its heading line(s).
      const minCut = previousCoreStart === undefined ? section.bodyStart + 1 : position + 1;
      const end =
        sectionEnd - position <= budget
          ? sectionEnd
          : findCut(text, position, budget, minCut, cutOptions).position;
      const content = text.slice(start, end);
      const symbol = section.declarations ? symbolOf(section.declarations, position, end) : null;
      drafts.push({
        chunkIndex: drafts.length,
        content,
        startOffset: start,
        endOffset: end,
        charCount: content.length,
        tokenEstimate: Math.ceil(content.length / 4),
        headingPath: isCode ? (symbol === null ? [] : [symbol]) : [...section.headingPath],
        overlapChars: position - start,
        startLine: lines.lineOf(start),
        endLine: lines.lineOf(end - 1),
        symbol,
      });

      previousCoreStart = position;
      position = skipWhitespace(text, end, sectionEnd);
    }
  }
  return drafts;
}

/** 1-based line numbers of offsets, by binary search over the line starts. */
export function createLineIndex(text: string): { lineOf(offset: number): number } {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return {
    lineOf(offset) {
      let low = 0;
      let high = starts.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if ((starts[middle] ?? 0) <= offset) {
          low = middle;
        } else {
          high = middle - 1;
        }
      }
      return low + 1;
    },
  };
}

/** Named declarations overlapping the chunk's new text `[from, to)`, joined for display. */
function symbolOf(
  declarations: readonly { start: number; end: number; symbol: string | null }[],
  from: number,
  to: number,
): string | null {
  const names = declarations
    .filter((declaration) => declaration.start < to && declaration.end > from)
    .flatMap((declaration) => (declaration.symbol === null ? [] : [declaration.symbol]));
  if (names.length === 0) {
    return null;
  }
  const shown = names.slice(0, MAX_SYMBOLS_PER_CHUNK).join(', ');
  return names.length > MAX_SYMBOLS_PER_CHUNK ? `${shown}, …` : shown;
}

function assertValidOptions({ targetSize, overlap, format }: ChunkingOptions): void {
  if (!Number.isInteger(targetSize) || targetSize < 1) {
    throw new RangeError('targetSize must be a positive integer');
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= targetSize) {
    throw new RangeError('overlap must be an integer >= 0 and smaller than targetSize');
  }
  if (!CHUNKING_FORMATS.includes(format)) {
    throw new RangeError('format must be "markdown", "text" or "code"');
  }
}

function sectionsOf(text: string, { format, language, targetSize }: ChunkingOptions): Section[] {
  if (format === 'text') {
    return [{ start: 0, end: text.length, bodyStart: 0, headingPath: [] }];
  }
  if (format === 'code') {
    return mergeCodeSections(text, splitCodeSections(text, language), targetSize);
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
 * Packs consecutive declaration sections greedily into one section while their trimmed text fits
 * into `targetSize` together, so small declarations (type aliases, constants, imports) share a
 * chunk while every declaration that fits stays whole.
 */
function mergeCodeSections(
  text: string,
  sections: readonly { start: number; end: number; symbol: string | null }[],
  targetSize: number,
): Section[] {
  const merged: Section[] = [];
  let current: Section | undefined;
  for (const section of sections) {
    const declaration = { start: section.start, end: section.end, symbol: section.symbol };
    if (current !== undefined) {
      const contentStart = skipWhitespace(text, current.start, section.end);
      const contentEnd = trimEnd(text, contentStart, section.end);
      if (contentEnd - contentStart <= targetSize) {
        current.end = section.end;
        current.declarations?.push(declaration);
        continue;
      }
      merged.push(current);
    }
    current = {
      start: section.start,
      end: section.end,
      bodyStart: section.start,
      headingPath: [],
      declarations: [declaration],
    };
  }
  if (current !== undefined) {
    merged.push(current);
  }
  return merged;
}

/**
 * Overlap start for source code: the first line start in `[from, position)` (its first
 * non-whitespace character), or `position` (no overlap) if the range contains no line start.
 */
function lineOverlapStart(text: string, from: number, position: number): number {
  for (let candidate = from; candidate < position; candidate++) {
    if (!isWordStart(text, candidate)) {
      continue;
    }
    let before = candidate;
    while (before > 0 && isWhitespace(text[before - 1]) && text[before - 1] !== '\n') {
      before--;
    }
    if (before === 0 || text[before - 1] === '\n') {
      return candidate;
    }
  }
  return position;
}

/**
 * Length of the line starting at `from` without trailing whitespace; `Infinity` if it is longer
 * than `targetSize` (it is cut at word ends anyway, so no overlap is kept).
 */
function firstLineLength(text: string, from: number, sectionEnd: number, targetSize: number) {
  const lineEnd = text.indexOf('\n', from);
  const end = trimEnd(text, from, lineEnd === -1 || lineEnd > sectionEnd ? sectionEnd : lineEnd);
  return end - from <= targetSize ? end - from : Number.POSITIVE_INFINITY;
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
