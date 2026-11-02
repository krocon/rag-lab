import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpConfig } from '../config.js';
import { RaglabApiError, ToolInputError } from '../errors.js';
import { capText, errorText, type BoundaryFactory } from '../format.js';
import type { Logger } from '../logger.js';
import type { RaglabClient } from '../raglab-client.js';

/** Everything a tool needs; created once by `createRaglabMcpServer`. */
export interface ToolContext {
  client: RaglabClient;
  config: Pick<McpConfig, 'maxOutputChars'>;
  logger: Logger;
  /** Random id of the untrusted-content markers (replaceable for deterministic tests). */
  boundary: BoundaryFactory;
}

/** Common annotations: every RAGLab tool only reads and talks to the local RAGLab API only. */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

/** A successful result with readable text (capped) and structured content. */
export function success(
  context: ToolContext,
  text: string,
  structuredContent: Record<string, unknown>,
): CallToolResult {
  return {
    content: [{ type: 'text', text: capText(text, context.config.maxOutputChars) }],
    structuredContent,
  };
}

/**
 * Runs a tool handler and turns expected failures into tool errors (`isError: true`) with an
 * understandable message instead of protocol errors – the model can read and react to them, and
 * the server keeps running. Unexpected errors are logged (stderr, without content) and reported
 * generically, never with a stack trace. Cancellation by the client is rethrown.
 */
export async function runTool(
  name: string,
  context: ToolContext,
  signal: AbortSignal,
  handler: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const started = performance.now();
  try {
    const result = await handler();
    context.logger.info(`${name} ok in ${Math.round(performance.now() - started)} ms`);
    return result;
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    if (error instanceof RaglabApiError || error instanceof ToolInputError) {
      context.logger.warn(`${name} failed: ${error.code}`);
      return { content: [{ type: 'text', text: errorText(error) }], isError: true };
    }
    context.logger.error(
      `${name} failed unexpectedly: ${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'}`,
    );
    return {
      content: [{ type: 'text', text: 'Internal error of the RAGLab MCP server.' }],
      isError: true,
    };
  }
}
