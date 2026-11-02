/**
 * Text boundaries used by the chunker, from coarse to fine. All positions are UTF-16 code unit
 * offsets (consistent with `String.prototype.slice`).
 *
 * A boundary is the **end** of a unit: position `i` with a non-whitespace character at `i - 1`
 * and whitespace at `i`. Every paragraph, sentence and line end is therefore also a word end.
 *
 * Heuristics and their limits (docs/adr/0002-rag-pipeline.md §2):
 * - Paragraph end: followed by a blank line (`\n`, optional spaces/tabs, `\n`).
 * - Sentence end: `.`, `!` or `?`, optionally followed by closing quotes/brackets (also German
 *   and French quotes), then
 *   whitespace. Abbreviations (`e.g. `, `z. B. `) produce false sentence ends; sentences without
 *   terminal punctuation are only split at line or word boundaries. Decimal numbers (`1.5`) and
 *   URLs are not split because no whitespace follows the dot.
 * - Line end: followed by a line break (after optional spaces/tabs). Ranked below sentences so
 *   hard-wrapped prose is cut at sentence ends first; lists and code use line ends.
 * - Word end: followed by whitespace. Words are separated by whitespace only, so scripts without
 *   spaces (e.g. Chinese) fall back to hard cuts.
 */

export const BoundaryLevel = {
  Hard: 0,
  Word: 1,
  Line: 2,
  Sentence: 3,
  Paragraph: 4,
} as const;

export type BoundaryLevel = (typeof BoundaryLevel)[keyof typeof BoundaryLevel];

const WHITESPACE = /\s/;
const SENTENCE_TERMINATORS = new Set(['.', '!', '?']);
const CLOSING_PUNCTUATION = new Set(['"', "'", ')', ']', '»', '«', '”', '“', '’', '‘']);

export function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && WHITESPACE.test(char);
}

/** First non-whitespace position in `[from, to)`, or `to` if there is none. */
export function skipWhitespace(text: string, from: number, to: number): number {
  let position = from;
  while (position < to && isWhitespace(text[position])) {
    position++;
  }
  return position;
}

/** End of `[from, to)` without trailing whitespace (`from` if the range is blank). */
export function trimEnd(text: string, from: number, to: number): number {
  let position = to;
  while (position > from && isWhitespace(text[position - 1])) {
    position--;
  }
  return position;
}

/** True if a unit ends at `position` (non-whitespace before, whitespace at `position`). */
export function isWordEnd(text: string, position: number): boolean {
  return position > 0 && !isWhitespace(text[position - 1]) && isWhitespace(text[position]);
}

/** True if a word starts at `position` (non-whitespace at, whitespace or text start before). */
export function isWordStart(text: string, position: number): boolean {
  return (
    !isWhitespace(text[position]) &&
    text[position] !== undefined &&
    (position === 0 || isWhitespace(text[position - 1]))
  );
}

/** True if the characters before `end` (a word end) close a sentence. */
export function endsSentence(text: string, end: number): boolean {
  let position = end - 1;
  while (position >= 0 && CLOSING_PUNCTUATION.has(text[position] ?? '')) {
    position--;
  }
  return position >= 0 && SENTENCE_TERMINATORS.has(text[position] ?? '');
}

/**
 * Number of line breaks in the whitespace run starting at `position` that consists of spaces,
 * tabs and line breaks only (stops counting at 2).
 */
function lineBreaksAhead(text: string, position: number): number {
  let breaks = 0;
  for (let i = position; i < text.length && breaks < 2; i++) {
    const char = text[i];
    if (char === '\n') {
      breaks++;
    } else if (char !== ' ' && char !== '\t') {
      break;
    }
  }
  return breaks;
}

/** Level of the boundary at `position`, assuming `isWordEnd(text, position)`. */
export function boundaryLevel(text: string, position: number): BoundaryLevel {
  const breaks = lineBreaksAhead(text, position);
  if (breaks >= 2) {
    return BoundaryLevel.Paragraph;
  }
  if (endsSentence(text, position)) {
    return BoundaryLevel.Sentence;
  }
  return breaks === 1 ? BoundaryLevel.Line : BoundaryLevel.Word;
}

/**
 * True if the word starting at `position` begins a sentence or a line: the preceding
 * non-whitespace text ends a sentence, or the whitespace in between contains a line break.
 */
export function startsSentence(text: string, position: number): boolean {
  let before = position;
  let lineBreak = false;
  while (before > 0 && isWhitespace(text[before - 1])) {
    before--;
    if (text[before] === '\n') {
      lineBreak = true;
    }
  }
  return before === 0 || lineBreak || endsSentence(text, before);
}

/**
 * Best cut position in `(from, from + budget]` for a unit starting at `from` (non-whitespace):
 * the last boundary of the coarsest level available. Boundaries before `minPosition` are only
 * used if there is no line, sentence or paragraph end at or after it (the chunker uses this to
 * keep a heading line together with the start of its section body without cutting mid-sentence). Without any boundary (a word longer than
 * `budget`) the cut is hard at `from + budget`, but never between the two halves of a surrogate
 * pair.
 */
export function findCut(
  text: string,
  from: number,
  budget: number,
  minPosition = from + 1,
): { position: number; level: BoundaryLevel } {
  const best: (number | undefined)[] = [];
  const limit = Math.min(from + budget, text.length);
  for (let position = Math.max(minPosition, from + 1); position <= limit; position++) {
    if (isWordEnd(text, position)) {
      best[boundaryLevel(text, position)] = position;
    }
  }
  const restricted = minPosition > from + 1;
  for (const level of [
    BoundaryLevel.Paragraph,
    BoundaryLevel.Sentence,
    BoundaryLevel.Line,
    BoundaryLevel.Word,
  ]) {
    const position = best[level];
    // A restricted search must not trade a line/sentence/paragraph end for a mid-sentence cut.
    if (position !== undefined && !(restricted && level < BoundaryLevel.Line)) {
      return { position, level };
    }
  }
  if (restricted) {
    return findCut(text, from, budget);
  }
  return { position: hardCut(text, from, budget), level: BoundaryLevel.Hard };
}

function hardCut(text: string, from: number, budget: number): number {
  let position = Math.min(from + budget, text.length);
  if (isHighSurrogate(text.charCodeAt(position - 1)) && isLowSurrogate(text.charCodeAt(position))) {
    // Keep the pair together; with a budget of 1 the pair is taken as a whole (2 code units).
    position = position - 1 > from ? position - 1 : position + 1;
  }
  return position;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
