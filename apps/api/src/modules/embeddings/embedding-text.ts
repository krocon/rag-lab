/**
 * What is embedded for a chunk (ADR 0004): for documents with a path (imported sources), a short
 * context header in front of the chunk text, so that a question about "the tree table factory"
 * also finds a chunk whose text never mentions the file or class name. The stored `content` stays
 * unchanged (offsets, citations); the header is derived from stored fields only, so the
 * playground can show exactly what was embedded.
 *
 * Documents without a path (uploads in the web app, `demo:seed`) are embedded as before: the
 * chunk text alone.
 */
export interface EmbeddingTextSource {
  /** Relative document path; `null` → no header. */
  path: string | null;
  content: string;
  /** Source code: enclosing declaration(s). */
  symbol?: string | null | undefined;
  /** Markdown: enclosing headings (source code: `[path, symbol]`, not used for the header). */
  headingPath?: readonly string[] | undefined;
}

/** Maximum header length in characters (long paths and symbol lists are cut). */
export const MAX_EMBEDDING_HEADER_CHARS = 400;

/**
 * `File: <path>\n[Symbol: <symbol>\n | Section: <a > b>\n]\n`, or `null` without a path.
 * The embedded text is exactly `header + content`.
 */
export function embeddingHeader(source: Omit<EmbeddingTextSource, 'content'>): string | null {
  if (source.path === null) {
    return null;
  }
  const lines = [`File: ${source.path}`];
  if (source.symbol) {
    lines.push(`Symbol: ${source.symbol}`);
  } else if (source.headingPath && source.headingPath.length > 0 && source.headingPath[0] !== source.path) {
    lines.push(`Section: ${source.headingPath.join(' > ')}`);
  }
  const header = lines.join('\n').replace(/[\r\t]/g, ' ');
  const characters = Array.from(header);
  const limited =
    characters.length > MAX_EMBEDDING_HEADER_CHARS
      ? characters.slice(0, MAX_EMBEDDING_HEADER_CHARS).join('')
      : header;
  return `${limited}\n\n`;
}

/** The text sent to the embedding provider for a chunk. */
export function embeddingText(source: EmbeddingTextSource): string {
  return (embeddingHeader(source) ?? '') + source.content;
}
