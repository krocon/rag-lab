/**
 * Minimal logger for the MCP server. Writes to **stderr only**: stdout belongs to the MCP
 * protocol (stdio transport), any other output there would corrupt the JSON-RPC stream.
 * Never log document content, queries, questions or answers – only codes, counts and timings.
 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function createStderrLogger(write: (line: string) => void = defaultWrite): Logger {
  const log = (level: string) => (message: string) =>
    write(`${new Date().toISOString()} raglab-mcp ${level}: ${message.replace(/[\r\n]+/g, ' ')}\n`);
  return { info: log('info'), warn: log('warn'), error: log('error') };
}

function defaultWrite(line: string): void {
  process.stderr.write(line);
}

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
