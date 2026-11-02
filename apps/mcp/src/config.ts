import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Configuration of the MCP server, validated from environment variables at startup. */
export interface McpConfig {
  /** Base URL of the RAGLab API without trailing slash, e.g. `http://127.0.0.1:3000`. */
  apiUrl: string;
  /** Upper bound for the characters of one tool result (text and structured content each). */
  maxOutputChars: number;
  /** Timeout of one JSON request to the API in milliseconds. */
  requestTimeoutMs: number;
  /** Timeout of a whole `ask_knowledge` call (retrieval + streamed answer) in milliseconds. */
  chatTimeoutMs: number;
}

export const DEFAULT_API_URL = 'http://127.0.0.1:3000';
export const MIN_OUTPUT_CHARS = 2_000;
export const MAX_OUTPUT_CHARS_LIMIT = 200_000;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const intInRange = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const schema = z.object({
  RAGLAB_API_URL: z
    .string()
    .default(DEFAULT_API_URL)
    .transform((value, context) => {
      const result = normalizeApiUrl(value);
      if (typeof result !== 'string') {
        context.addIssue({ code: 'custom', message: result.error });
        return z.NEVER;
      }
      return result;
    }),
  // Default 20 000 characters ≈ 5 000 tokens: enough for 8–16 chunks, small enough for agents.
  MCP_MAX_OUTPUT_CHARS: intInRange(MIN_OUTPUT_CHARS, MAX_OUTPUT_CHARS_LIMIT, 20_000),
  // Above the API's default EMBEDDING_TIMEOUT_MS (60 s): a search may load the embedding model.
  MCP_REQUEST_TIMEOUT_MS: intInRange(1_000, 600_000, 90_000),
  MCP_CHAT_TIMEOUT_MS: intInRange(1_000, 1_800_000, 300_000),
});

/**
 * Validates and normalises the API base URL: `http`/`https` only, no credentials (fetch rejects
 * them and the API has no authentication), no query or fragment, no trailing slash.
 */
export function normalizeApiUrl(value: string): string | { error: string } {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { error: 'must be an absolute URL such as http://127.0.0.1:3000' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: 'must use http or https' };
  }
  if (url.username || url.password) {
    return { error: 'must not contain credentials' };
  }
  if (url.search || url.hash) {
    return { error: 'must not contain a query or fragment' };
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): McpConfig {
  // Treat empty strings like unset variables (`.env` lines such as `RAGLAB_API_URL=`).
  const env = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`),
    );
  }
  return {
    apiUrl: parsed.data.RAGLAB_API_URL,
    maxOutputChars: parsed.data.MCP_MAX_OUTPUT_CHARS,
    requestTimeoutMs: parsed.data.MCP_REQUEST_TIMEOUT_MS,
    chatTimeoutMs: parsed.data.MCP_CHAT_TIMEOUT_MS,
  };
}

/** `127.0.0.0/8`, `::1` and `localhost` – reachable from this machine only. */
export function isLoopbackUrl(apiUrl: string): boolean {
  const host = new URL(apiUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** Warnings logged at startup (stderr). */
export function configWarnings(config: McpConfig): string[] {
  return isLoopbackUrl(config.apiUrl)
    ? []
    : [
        `RAGLAB_API_URL points to a non-local host (${new URL(config.apiUrl).host}). The RAGLab ` +
          'API has no authentication; only use it behind a protecting layer (docs/security.md).',
      ];
}

/**
 * Loads the repository-root `.env` (if present), like the API does. Variables that are already
 * set – e.g. by the MCP client configuration – win.
 */
export function loadEnvFile(path = fileURLToPath(new URL('../../../.env', import.meta.url))): void {
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}
