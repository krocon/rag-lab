/**
 * Allowlist of uploadable file types (docs/architecture.md §4.1, ADR 0004). The MIME type and the
 * language are derived from the extension and never taken from the client (`Content-Type` of a
 * multipart part is ignored).
 *
 * `language` drives the chunking format: `markdown` → Markdown chunking, `text` → plain text,
 * everything else → source code chunking (`chunking/code-sections.ts`).
 */
export const SUPPORTED_FILE_TYPES = {
  '.md': { mimeType: 'text/markdown', language: 'markdown' },
  '.markdown': { mimeType: 'text/markdown', language: 'markdown' },
  '.txt': { mimeType: 'text/plain', language: 'text' },
  '.ts': { mimeType: 'text/typescript', language: 'typescript' },
  '.tsx': { mimeType: 'text/typescript', language: 'typescript' },
  '.mts': { mimeType: 'text/typescript', language: 'typescript' },
  '.cts': { mimeType: 'text/typescript', language: 'typescript' },
  '.js': { mimeType: 'text/javascript', language: 'javascript' },
  '.jsx': { mimeType: 'text/javascript', language: 'javascript' },
  '.mjs': { mimeType: 'text/javascript', language: 'javascript' },
  '.cjs': { mimeType: 'text/javascript', language: 'javascript' },
  '.vue': { mimeType: 'text/x-vue', language: 'vue' },
  '.svelte': { mimeType: 'text/x-svelte', language: 'svelte' },
  '.astro': { mimeType: 'text/x-astro', language: 'astro' },
  '.html': { mimeType: 'text/html', language: 'html' },
  '.htm': { mimeType: 'text/html', language: 'html' },
  '.css': { mimeType: 'text/css', language: 'css' },
  '.scss': { mimeType: 'text/x-scss', language: 'scss' },
  '.json': { mimeType: 'application/json', language: 'json' },
  '.yaml': { mimeType: 'application/yaml', language: 'yaml' },
  '.yml': { mimeType: 'application/yaml', language: 'yaml' },
  '.toml': { mimeType: 'application/toml', language: 'toml' },
  '.sh': { mimeType: 'text/x-shellscript', language: 'shell' },
  '.py': { mimeType: 'text/x-python', language: 'python' },
  '.java': { mimeType: 'text/x-java', language: 'java' },
  '.kt': { mimeType: 'text/x-kotlin', language: 'kotlin' },
  '.go': { mimeType: 'text/x-go', language: 'go' },
  '.rs': { mimeType: 'text/x-rust', language: 'rust' },
  '.cs': { mimeType: 'text/x-csharp', language: 'csharp' },
  '.sql': { mimeType: 'application/sql', language: 'sql' },
} as const;

export type SupportedExtension = keyof typeof SUPPORTED_FILE_TYPES;
export type FileTypeInfo = (typeof SUPPORTED_FILE_TYPES)[SupportedExtension];
export type DocumentMimeType = FileTypeInfo['mimeType'];
export type DocumentLanguage = FileTypeInfo['language'];

export const SUPPORTED_EXTENSIONS = Object.keys(SUPPORTED_FILE_TYPES) as SupportedExtension[];

/** Language of every MIME type (each MIME type belongs to exactly one language). */
const LANGUAGE_BY_MIME_TYPE: ReadonlyMap<string, DocumentLanguage> = new Map(
  Object.values(SUPPORTED_FILE_TYPES).map((info) => [info.mimeType, info.language]),
);

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
export const UNSAFE_FILENAME_CHARACTERS =
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

/** Type information of an allowed filename, `undefined` if the extension is not on the allowlist. */
export function resolveFileType(filename: string): FileTypeInfo | undefined {
  const extension = fileExtension(filename);
  return Object.hasOwn(SUPPORTED_FILE_TYPES, extension)
    ? SUPPORTED_FILE_TYPES[extension as SupportedExtension]
    : undefined;
}

/** MIME type for an allowed filename, `undefined` if the extension is not on the allowlist. */
export function resolveMimeType(filename: string): DocumentMimeType | undefined {
  return resolveFileType(filename)?.mimeType;
}

/** Language of a stored document's MIME type; `text` for unknown MIME types. */
export function languageForMimeType(mimeType: string): DocumentLanguage {
  return LANGUAGE_BY_MIME_TYPE.get(mimeType) ?? 'text';
}
