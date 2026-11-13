/** Where a chunk comes from: enough to print `path:start–end` (or the file name as fallback). */
export interface SourceLocationParts {
  filename: string;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
}

/** Languages shown as prose; everything else is source code (ADR 0004). */
const PROSE_LANGUAGES: ReadonlySet<string> = new Set(['markdown', 'text']);

/** Whether a document language is source code (monospace view with line numbers). */
export function isCodeLanguage(language: string | null | undefined): boolean {
  return typeof language === 'string' && language !== '' && !PROSE_LANGUAGES.has(language);
}

/**
 * `10–42`, or `10` for a single line; `null` when the range is unknown (chunks stored before
 * line numbers existed) or not a valid 1-based range.
 */
export function formatLineRange(startLine: number | null, endLine: number | null): string | null {
  if (
    startLine === null ||
    endLine === null ||
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    return null;
  }
  return startLine === endLine ? String(startLine) : `${startLine}–${endLine}`;
}

/** `packages/table/src/tree.ts:10–42`; falls back to the file name and omits unknown lines. */
export function formatSourceLocation(source: SourceLocationParts): string {
  const name = source.path || source.filename;
  const lines = formatLineRange(source.startLine, source.endLine);
  return lines === null ? name : `${name}:${lines}`;
}

/**
 * Returns the URL only when it is an absolute `https://` URL without credentials, else `null`.
 * Defence in depth: the server already builds and validates source links, but nothing that could
 * become a `javascript:`/`data:` link or leak credentials is ever rendered as `href`.
 */
export function safeHttpsUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname === '' ||
    parsed.username ||
    parsed.password
  ) {
    return null;
  }
  return url;
}

/** Host name for link labels (`View on github.com`); `null` for URLs that are not safe. */
export function linkHost(url: string | null | undefined): string | null {
  const safe = safeHttpsUrl(url);
  return safe === null ? null : new URL(safe).hostname;
}

/** First 12 characters of a commit SHA for display (the full SHA belongs in a title/tooltip). */
export function shortCommit(commit: string): string {
  return commit.slice(0, 12);
}
