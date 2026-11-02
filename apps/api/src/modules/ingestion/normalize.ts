/**
 * Text normalisation for ingested documents (docs/adr/0002-rag-pipeline.md §1).
 *
 * The normalised text is what gets stored, hashed and chunked; all chunk offsets refer to it.
 * The function is pure and idempotent: `normalizeText(normalizeText(x)) === normalizeText(x)`.
 */

const BYTE_ORDER_MARK = '\uFEFF';

/** C0/C1 control characters except `\t` (U+0009) and `\n` (U+000A). `\r` is handled before. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point here
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/**
 * Three or more consecutive blank lines (lines that are empty or contain only spaces/tabs),
 * either at the start of the text or after a line break.
 */
const EXCESS_BLANK_LINES = /(^|\n)(?:[ \t]*\n){3,}/g;

/**
 * Normalises raw document text:
 *
 * 1. removes a leading byte order mark,
 * 2. converts `\r\n` and lone `\r` to `\n`,
 * 3. applies Unicode NFC,
 * 4. removes control characters except `\n` and `\t`,
 * 5. collapses runs of more than two blank lines into exactly two.
 *
 * Nothing else is rewritten: no trimming, no whitespace changes inside lines, no Markdown changes.
 */
export function normalizeText(raw: string): string {
  const withoutBom = raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(1) : raw;
  return withoutBom
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
    .replace(CONTROL_CHARACTERS, '')
    .replace(EXCESS_BLANK_LINES, (_match, lead: string) => `${lead}\n\n`);
}

/** True if the text has no visible content (empty or whitespace only). */
export function isBlank(text: string): boolean {
  return text.trim().length === 0;
}
