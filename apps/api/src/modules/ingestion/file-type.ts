/**
 * Allowlist of uploadable file types. The MIME type is derived from the extension and never taken
 * from the client (`Content-Type` of a multipart part is ignored).
 */
export const SUPPORTED_FILE_TYPES = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
} as const;

export type SupportedExtension = keyof typeof SUPPORTED_FILE_TYPES;
export type DocumentMimeType = (typeof SUPPORTED_FILE_TYPES)[SupportedExtension];

export const SUPPORTED_EXTENSIONS = Object.keys(SUPPORTED_FILE_TYPES) as SupportedExtension[];

/** Maximum length of a stored filename in characters (code points). */
export const MAX_FILENAME_LENGTH = 255;

const FALLBACK_FILENAME = 'untitled';

/**
 * Characters removed from filenames: control characters (C0, DEL, C1), Unicode bidi controls
 * (U+061C, U+200E/F, U+202A–U+202E, U+2066–U+2069), which can disguise the real extension in a
 * UI (`txt.exe` displayed as `exe.txt`), invisible characters that make two names look equal
 * (soft hyphen, zero-width space, word joiner and invisible operators, BOM, U+180E) and line or
 * paragraph separators. Zero-width (non-)joiners stay: emoji sequences and some scripts need them.
 */
const UNSAFE_FILENAME_CHARACTERS =
  // eslint-disable-next-line no-control-regex -- removing control characters is the point here
  /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Lower-case extension including the dot (`.md`), or `''` if the name has none. */
export function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

/**
 * Makes a client-supplied filename safe for storage and display: keeps only the last path
 * segment (`/` and `\`), removes control and bidi characters, applies NFC, trims whitespace and
 * limits the length to {@link MAX_FILENAME_LENGTH} characters while keeping the extension.
 * The result is display-only; it is never used as a file system path.
 */
export function sanitizeFilename(raw: string): string {
  const lastSegment = raw.split(/[/\\]/).pop() ?? '';
  const cleaned = lastSegment.replace(UNSAFE_FILENAME_CHARACTERS, '').normalize('NFC').trim();
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') {
    return FALLBACK_FILENAME;
  }
  const characters = Array.from(cleaned);
  if (characters.length <= MAX_FILENAME_LENGTH) {
    return cleaned;
  }
  const extension = Array.from(fileExtension(cleaned));
  if (extension.length >= MAX_FILENAME_LENGTH) {
    return characters.slice(0, MAX_FILENAME_LENGTH).join('');
  }
  const stem = characters.slice(0, characters.length - extension.length);
  return [...stem.slice(0, MAX_FILENAME_LENGTH - extension.length), ...extension].join('');
}

/** MIME type for an allowed filename, `undefined` if the extension is not on the allowlist. */
export function resolveMimeType(filename: string): DocumentMimeType | undefined {
  const extension = fileExtension(filename);
  return Object.hasOwn(SUPPORTED_FILE_TYPES, extension)
    ? SUPPORTED_FILE_TYPES[extension as SupportedExtension]
    : undefined;
}
