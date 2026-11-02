/** A parsed SSE event (test helper). `data` is the JSON-decoded `data:` line. */
export interface ParsedSseEvent {
  event: string;
  data: unknown;
}

/**
 * Minimal SSE parser for tests: frames are separated by a blank line; comment lines (`:`) are
 * ignored; every frame must have exactly one `event:` and one `data:` line.
 */
export function parseSse(body: string): ParsedSseEvent[] {
  return body
    .split('\n\n')
    .map((frame) => frame.split('\n').filter((line) => line.length > 0 && !line.startsWith(':')))
    .filter((lines) => lines.length > 0)
    .map((lines) => {
      const event = lines.filter((line) => line.startsWith('event: '));
      const data = lines.filter((line) => line.startsWith('data: '));
      if (event.length !== 1 || data.length !== 1 || lines.length !== 2) {
        throw new Error(`malformed SSE frame: ${JSON.stringify(lines)}`);
      }
      return {
        event: (event[0] ?? '').slice('event: '.length),
        data: JSON.parse((data[0] ?? '').slice('data: '.length)) as unknown,
      };
    });
}
