/**
 * Neutralisation of the prompt's source delimiters (docs/security.md, ADR 0002 §5).
 *
 * Documents and questions are untrusted. They must not be able to end their own `<source>` block
 * or fake another one, so anything that looks like an opening or closing source tag is defused by
 * replacing its opening bracket with `&lt;`. Besides the exact ASCII form this covers variants a
 * model may still read as a tag:
 *
 * - whitespace and any case: `< / SOURCE`, `<Source`
 * - invisible format characters inside the tag (zero-width space/joiner, bidi marks, soft hyphen)
 * - look-alike brackets and slashes: `＜` (fullwidth), `﹤`, `‹`, `〈`, `⟨`, `〈`; `／`, `∕`, `⁄`
 * - fullwidth letters and common Cyrillic/Greek homoglyphs of `s o u r c e`
 *
 * Text without such a tag stays byte-for-byte unchanged (code samples keep their `<`, and
 * `<sourcemap>` or `<source-code>` are not touched). This lowers the risk of delimiter confusion;
 * it does not prevent prompt injection – a document can still contain persuasive instructions.
 */

/** `<` and characters that look like it. */
const OPEN_BRACKETS = '<\\uFF1C\\uFE64\\u2039\\u2329\\u27E8\\u3008';
/** `/` and characters that look like it. */
const SLASHES = '/\\uFF0F\\u2215\\u2044\\u29F8';
/** Invisible characters a tag could be padded with: whitespace and Unicode format (Cf) characters. */
const GAP = '[\\s\\p{Cf}]*';

/** Each letter of "source" with its fullwidth form and common homoglyphs (case-insensitive). */
const LETTERS: Record<string, string> = {
  s: 's\\uFF53\\uFF33\\u0455\\u0405',
  o: 'o\\uFF4F\\uFF2F\\u043E\\u041E\\u03BF\\u039F',
  u: 'u\\uFF55\\uFF35\\u03C5',
  r: 'r\\uFF52\\uFF32\\u0433',
  c: 'c\\uFF43\\uFF23\\u0441\\u0421\\u03F2',
  e: 'e\\uFF45\\uFF25\\u0435\\u0415',
};

const WORD = [...'source'].map((letter) => `[${LETTERS[letter] ?? letter}]`).join(GAP);

/**
 * Matches the opening bracket (group 1) and the rest of a source tag start (group 2), e.g. `<`
 * + ` / source`. The tag name must end there (no letter, digit, `_` or `-` follows).
 */
const SOURCE_TAG = new RegExp(
  `([${OPEN_BRACKETS}])(${GAP}(?:[${SLASHES}]${GAP})?${WORD})(?![\\p{L}\\p{N}_-])`,
  'giu',
);

/**
 * Replaces the bracket of every opening or closing source tag (including the variants listed
 * above) with `&lt;`, so the model sees text, not a delimiter. Idempotent.
 */
export function neutralizeSourceTags(text: string): string {
  return text.replace(SOURCE_TAG, '&lt;$2');
}
