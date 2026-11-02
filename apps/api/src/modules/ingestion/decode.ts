import { badRequest } from '../../http/errors.js';

/**
 * Maximum share of control characters (C0 except tab, line feed, form feed and carriage return,
 * DEL, C1) in a decoded text. Real text has next to none; binary data that happens to be valid
 * UTF-8 (no NUL bytes) has many.
 */
export const MAX_CONTROL_CHARACTER_RATIO = 0.1;

/** Texts shorter than this are not judged by the ratio (a single stray character in "a\x01"). */
const MIN_CHARACTERS_FOR_RATIO = 32;

/** Share of control characters (see {@link MAX_CONTROL_CHARACTER_RATIO}) in `text`, 0..1. */
export function controlCharacterRatio(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    const isControl =
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0c && code !== 0x0d) ||
      (code >= 0x7f && code <= 0x9f);
    if (isControl) {
      count++;
    }
  }
  return count / text.length;
}

/**
 * Decodes uploaded bytes as strict UTF-8.
 *
 * - NUL bytes mark the file as binary (this also rejects UTF-16 encoded text) → `400 INVALID_ENCODING`.
 * - Invalid UTF-8 sequences are rejected instead of being replaced by U+FFFD → `400 INVALID_ENCODING`.
 * - A UTF-8 byte order mark is removed by the decoder.
 * - More than {@link MAX_CONTROL_CHARACTER_RATIO} control characters mark the file as binary
 *   → `400 INVALID_ENCODING`.
 */
export function decodeUtf8(bytes: Uint8Array, filename = 'file'): string {
  if (bytes.includes(0)) {
    throw badRequest(
      'INVALID_ENCODING',
      `"${filename}" looks like a binary file (it contains NUL bytes). Only UTF-8 text files are supported.`,
      { filename },
    );
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw badRequest('INVALID_ENCODING', `"${filename}" is not valid UTF-8 text.`, { filename });
  }
  if (
    text.length >= MIN_CHARACTERS_FOR_RATIO &&
    controlCharacterRatio(text) > MAX_CONTROL_CHARACTER_RATIO
  ) {
    throw badRequest(
      'INVALID_ENCODING',
      `"${filename}" looks like a binary file (it contains many control characters). Only UTF-8 text files are supported.`,
      { filename },
    );
  }
  return text;
}
