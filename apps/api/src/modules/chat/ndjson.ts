/**
 * Streaming parser for newline-delimited JSON (one JSON value per line), as used by Ollama's
 * streaming endpoints. Robust against lines split across network chunks and multi-byte UTF-8
 * characters split across chunks; `\r\n` line endings and blank lines are accepted.
 */

/** A single line longer than this is treated as a broken stream (protects memory). */
export const MAX_NDJSON_LINE_CHARS = 1024 * 1024;

/** A line is not valid JSON or too long. The message never contains the line itself. */
export class NdjsonParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NdjsonParseError';
  }
}

/** Yields the parsed value of every non-empty line of `chunks`, in order. */
export async function* parseNdjson(
  chunks: AsyncIterable<Uint8Array | string>,
  { maxLineChars = MAX_NDJSON_LINE_CHARS }: { maxLineChars?: number } = {},
): AsyncGenerator<unknown, void, undefined> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let lineNumber = 0;
  for await (const chunk of chunks) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      lineNumber++;
      const value = parseLine(buffer.slice(0, newline), lineNumber);
      buffer = buffer.slice(newline + 1);
      if (value !== undefined) {
        yield value;
      }
      newline = buffer.indexOf('\n');
    }
    if (buffer.length > maxLineChars) {
      throw new NdjsonParseError(
        `NDJSON line ${lineNumber + 1} exceeds ${maxLineChars} characters.`,
      );
    }
  }
  buffer += decoder.decode();
  const last = parseLine(buffer, lineNumber + 1);
  if (last !== undefined) {
    yield last;
  }
}

function parseLine(line: string, lineNumber: number): unknown {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new NdjsonParseError(`NDJSON line ${lineNumber} is not valid JSON.`);
  }
}
