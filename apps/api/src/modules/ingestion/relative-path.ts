import { badRequest } from '../../http/errors.js';
import { UNSAFE_FILENAME_CHARACTERS } from './file-type.js';

/** Maximum length of a document path in characters (code points). */
export const MAX_PATH_LENGTH = 512;

/** Maximum length of one path segment in characters (code points). */
export const MAX_PATH_SEGMENT_LENGTH = 255;

/** Why a path was rejected (`details.reason` of `400 INVALID_PATH`). */
export type InvalidPathReason =
  | 'empty'
  | 'too_long'
  | 'absolute'
  | 'backslash'
  | 'empty_segment'
  | 'dot_segment'
  | 'segment_too_long'
  | 'unsafe_characters'
  | 'surrounding_whitespace';

const REASON_MESSAGES: Record<InvalidPathReason, string> = {
  empty: 'must not be empty',
  too_long: `must not be longer than ${MAX_PATH_LENGTH} characters`,
  absolute: 'must be relative (no leading "/" and no drive letter)',
  backslash: 'must use "/" as separator, not "\\"',
  empty_segment: 'must not contain empty segments ("//" or a trailing "/")',
  dot_segment: 'must not contain "." or ".." segments',
  segment_too_long: `must not contain segments longer than ${MAX_PATH_SEGMENT_LENGTH} characters`,
  unsafe_characters: 'must not contain control, bidi or invisible characters',
  surrounding_whitespace: 'segments must not start or end with whitespace',
};

/** Windows drive (`C:`), UNC-like prefixes are covered by the leading-slash/backslash checks. */
const DRIVE_LETTER = /^[A-Za-z]:/;

/**
 * Validates a client-supplied relative document path (e.g. `packages/table/src/x.ts`) and returns
 * it in NFC. The path is display and metadata information only and is **never** used as a file
 * system path; the strict rules keep it unambiguous (one spelling per file), keep spoofing
 * characters out of the UI and make prefix filters reliable.
 *
 * Returns the reason instead of the path if it is invalid.
 */
export function checkRelativePath(
  raw: string,
): { ok: true; path: string } | { ok: false; reason: InvalidPathReason } {
  // A fresh regex per call: the shared one is global (`g`) and therefore stateful in `test()`.
  if (new RegExp(UNSAFE_FILENAME_CHARACTERS.source).test(raw)) {
    return { ok: false, reason: 'unsafe_characters' };
  }
  const path = raw.normalize('NFC');
  if (path.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (Array.from(path).length > MAX_PATH_LENGTH) {
    return { ok: false, reason: 'too_long' };
  }
  if (path.includes('\\')) {
    return { ok: false, reason: 'backslash' };
  }
  if (path.startsWith('/') || DRIVE_LETTER.test(path)) {
    return { ok: false, reason: 'absolute' };
  }
  for (const segment of path.split('/')) {
    if (segment.length === 0) {
      return { ok: false, reason: 'empty_segment' };
    }
    if (segment === '.' || segment === '..') {
      return { ok: false, reason: 'dot_segment' };
    }
    if (segment.trim() !== segment) {
      return { ok: false, reason: 'surrounding_whitespace' };
    }
    if (Array.from(segment).length > MAX_PATH_SEGMENT_LENGTH) {
      return { ok: false, reason: 'segment_too_long' };
    }
  }
  return { ok: true, path };
}

/**
 * Like {@link checkRelativePath}, but throws `400 INVALID_PATH`. The rejected value is not echoed
 * (it may contain control characters); `details.reason` names the rule, `details.filename` the
 * (sanitised) file it belongs to.
 */
export function validateRelativePath(raw: string, filename: string): string {
  const result = checkRelativePath(raw);
  if (!result.ok) {
    throw badRequest(
      'INVALID_PATH',
      `The path of "${filename}" is invalid: it ${REASON_MESSAGES[result.reason]}.`,
      { filename, reason: result.reason },
    );
  }
  return result.path;
}
