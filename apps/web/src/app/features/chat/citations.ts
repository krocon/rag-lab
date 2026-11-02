/** One number inside a citation: `known` only if a source with this `n` was delivered. */
export interface CitationRef {
  n: number;
  known: boolean;
}

/** A piece of answer text: plain text, or a citation like `[1]` / `[1, 3]`. */
export type AnswerSegment =
  { type: 'text'; text: string } | { type: 'citation'; raw: string; refs: CitationRef[] };

/**
 * Same pattern as the API's `analyzeCitations` (`apps/api/src/modules/chat/citations.ts`):
 * square brackets with one or more comma-separated integers. `[1-2]`, `[a]`, `[1.5]` stay text.
 */
const CITATION_PATTERN = /\[\s*(\d{1,6}(?:\s*,\s*\d{1,6})*)\s*\]/g;

/**
 * Splits model output into text and citation segments – rendered with interpolation and buttons,
 * never as HTML. A number is `known` only if it is in `sourceNumbers` (the `sources` event);
 * everything else (model output is untrusted) must not be linked. An incomplete citation at the
 * end of a streaming answer (`[1`) stays text until its `]` arrives.
 */
export function segmentAnswer(text: string, sourceNumbers: ReadonlySet<number>): AnswerSegment[] {
  const segments: AnswerSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(CITATION_PATTERN)) {
    const index = match.index;
    if (index > last) {
      segments.push({ type: 'text', text: text.slice(last, index) });
    }
    const refs = (match[1] ?? '').split(',').map((part) => {
      const n = Number.parseInt(part.trim(), 10);
      return { n, known: sourceNumbers.has(n) };
    });
    segments.push({ type: 'citation', raw: match[0], refs });
    last = index + match[0].length;
  }
  if (last < text.length) {
    segments.push({ type: 'text', text: text.slice(last) });
  }
  return segments;
}
