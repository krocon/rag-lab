#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, configWarnings, loadConfig, loadEnvFile } from './config.js';
import { createStderrLogger } from './logger.js';
import { createRaglabClient } from './raglab-client.js';
import { createRaglabMcpServer, SERVER_VERSION } from './server.js';

/**
 * Entry point: MCP server over stdio. stdout carries only protocol messages; every log line goes
 * to stderr (see logger.ts).
 */
async function main(): Promise<void> {
  const logger = createStderrLogger();
  loadEnvFile();
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  for (const warning of configWarnings(config)) {
    logger.warn(warning);
  }

  const client = createRaglabClient({
    apiUrl: config.apiUrl,
    requestTimeoutMs: config.requestTimeoutMs,
    chatTimeoutMs: config.chatTimeoutMs,
    userAgent: `raglab-mcp/${SERVER_VERSION}`,
  });
  const server = createRaglabMcpServer({ client, config, logger });
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = (reason: string) => {
    if (closing) {
      return;
    }
    closing = true;
    logger.info(`shutting down (${reason})`);
    void server
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => shutdown(signal));
  }
  // The MCP client closes stdin when it disconnects.
  process.stdin.once('end', () => shutdown('stdin closed'));

  await server.connect(transport);
  logger.info(
    `RAGLab MCP server ${SERVER_VERSION} started (stdio), API ${new URL(config.apiUrl).origin}`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `raglab-mcp: failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
