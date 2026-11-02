import { z } from 'zod';

/**
 * pgvector can build an HNSW index on `vector` columns only up to 2,000 dimensions
 * (`halfvec`: 4,000). Larger embeddings need a schema change, see docs/adr/0002-rag-pipeline.md.
 */
export const MAX_INDEXABLE_VECTOR_DIMENSIONS = 2000;

const MIB = 1024 * 1024;

/** Upper bound for `MAX_UPLOAD_BYTES` (50 MiB): uploads are validated in memory. */
export const MAX_UPLOAD_BYTES_LIMIT = 50 * MIB;

/** Upper bound for `topK` (`RETRIEVAL_TOP_K` and per request). */
export const MAX_TOP_K = 100;

/** Upper bound for `MAX_QUERY_CHARS`: queries are embedded as one text. */
export const MAX_QUERY_CHARS_LIMIT = 20_000;

/** Bounds of `CHAT_CONTEXT_CHAR_BUDGET` (characters of all source blocks in one prompt). */
export const MIN_CONTEXT_CHAR_BUDGET = 1000;
export const MAX_CONTEXT_CHAR_BUDGET = 200_000;

/** `MAX_QUESTION_CHARS` when unset (capped at `MAX_QUERY_CHARS`). */
const DEFAULT_MAX_QUESTION_CHARS = 2000;

/** Upper bound for `MAX_UPLOAD_REQUEST_BYTES` (all files of one request are held in memory). */
export const MAX_UPLOAD_REQUEST_BYTES_LIMIT = 500 * MIB;

/** Default of `MAX_UPLOAD_REQUEST_BYTES` (100 MiB, matches nginx `client_max_body_size`). */
const DEFAULT_MAX_UPLOAD_REQUEST_BYTES = 100 * MIB;

/** Host names accepted by default (`ALLOWED_HOSTS`): loopback only, see docs/security.md. */
export const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

const port = z.coerce.number().int().min(1).max(65_535);
const positiveInt = z.coerce.number().int().positive();
/** `true`/`false` (also `1`/`0`, `yes`/`no`), case-insensitive. */
const booleanFlag = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no']))
  .transform((value) => value === 'true' || value === '1' || value === 'yes');
const commaList = (value: string) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

/** True if `value` is exactly a browser origin (`scheme://host[:port]`, no path, no wildcard). */
function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PORT: port.default(3000),
    // Exact browser origins; `*` and anything that is not a plain origin are rejected.
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:4200')
      .transform(commaList)
      .refine((origins) => origins.every(isOrigin), {
        message:
          'CORS_ORIGINS must be a comma-separated list of exact origins such as http://localhost:4200 (no "*", no path, no trailing slash)',
      }),
    // Accepted `Host` header names (DNS-rebinding protection); `*` disables the check.
    ALLOWED_HOSTS: z.string().default(DEFAULT_ALLOWED_HOSTS.join(',')).transform(commaList),
    // Set to true only if another layer restricts network access to the API (reverse proxy with
    // authentication, private container network, firewall). Silences the startup warning.
    NETWORK_ACCESS_PROTECTED: booleanFlag.default(false),
    // Swagger UI and the OpenAPI document under /api/docs.
    API_DOCS_ENABLED: booleanFlag.default(true),
    // Maximum time to receive a complete request (headers and body), e.g. a slow upload.
    REQUEST_TIMEOUT_MS: positiveInt.min(1000).max(3_600_000).default(120_000),

    // Rate limits per client IP and time window (in-memory, per API process).
    RATE_LIMIT_ENABLED: booleanFlag.default(true),
    RATE_LIMIT_WINDOW_MS: positiveInt.min(1000).max(3_600_000).default(60_000),
    RATE_LIMIT_MAX: positiveInt.max(1_000_000).default(300),
    RATE_LIMIT_UPLOAD_MAX: positiveInt.max(1_000_000).default(30),
    RATE_LIMIT_CHAT_MAX: positiveInt.max(1_000_000).default(20),
    RATE_LIMIT_SEARCH_MAX: positiveInt.max(1_000_000).default(60),
    // Chat requests processed at the same time (retrieval + streaming answer).
    MAX_CONCURRENT_CHATS: positiveInt.max(256).default(4),

    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required')
      .refine((value) => /^postgres(ql)?:\/\//.test(value), {
        message: 'DATABASE_URL must be a postgres:// or postgresql:// connection string',
      }),
    DATABASE_POOL_MAX: positiveInt.default(10),

    OLLAMA_BASE_URL: z.url().default('http://localhost:11434'),

    // Provider and model names are configuration, never code constants (provider neutrality).
    EMBEDDING_PROVIDER: z.enum(['ollama']).default('ollama'),
    EMBEDDING_MODEL: z.string().min(1, 'EMBEDDING_MODEL is required'),
    EMBEDDING_DIMENSIONS: positiveInt.max(MAX_INDEXABLE_VECTOR_DIMENSIONS, {
      message: `EMBEDDING_DIMENSIONS must be <= ${MAX_INDEXABLE_VECTOR_DIMENSIONS} (pgvector HNSW limit for vector columns)`,
    }),
    // Texts per provider request and the timeout of a single request (not of a whole document).
    EMBEDDING_BATCH_SIZE: positiveInt.max(512).default(32),
    EMBEDDING_TIMEOUT_MS: positiveInt.min(1000).max(600_000).default(60_000),
    CHAT_PROVIDER: z.enum(['ollama']).default('ollama'),
    CHAT_MODEL: z.string().min(1, 'CHAT_MODEL is required'),
    // Maximum wait for the next piece of a streamed answer (also covers loading the model).
    CHAT_TIMEOUT_MS: positiveInt.min(1000).max(600_000).default(120_000),
    // Characters of all <source> blocks of one prompt; sources are added in rank order.
    CHAT_CONTEXT_CHAR_BUDGET: positiveInt
      .min(MIN_CONTEXT_CHAR_BUDGET)
      .max(MAX_CONTEXT_CHAR_BUDGET)
      .default(12_000),
    // Maximum length of a chat question (characters after trimming); <= MAX_QUERY_CHARS.
    // Unset: min(2000, MAX_QUERY_CHARS).
    MAX_QUESTION_CHARS: positiveInt.max(MAX_QUERY_CHARS_LIMIT).optional(),

    RETRIEVAL_TOP_K: positiveInt.max(MAX_TOP_K).default(8),
    // Maximum length of a search query (characters after trimming).
    MAX_QUERY_CHARS: positiveInt.max(MAX_QUERY_CHARS_LIMIT).default(2000),
    CHUNK_SIZE: positiveInt.default(1200),
    CHUNK_OVERLAP: z.coerce.number().int().min(0).default(200),

    // Uploads are held in memory while they are validated (all files of a request), so the
    // limits are capped; MAX_UPLOAD_REQUEST_BYTES bounds the sum of one request.
    MAX_UPLOAD_BYTES: positiveInt.max(MAX_UPLOAD_BYTES_LIMIT).default(5 * MIB),
    MAX_UPLOAD_FILES: positiveInt.max(100).default(20),
    // Total bytes of all files of one upload request (caps MAX_UPLOAD_BYTES × MAX_UPLOAD_FILES).
    MAX_UPLOAD_REQUEST_BYTES: positiveInt
      .max(MAX_UPLOAD_REQUEST_BYTES_LIMIT)
      .default(DEFAULT_MAX_UPLOAD_REQUEST_BYTES),
    // Optional cap on documents per collection; unset = unlimited.
    MAX_DOCUMENTS_PER_COLLECTION: positiveInt.max(1_000_000).optional(),
    INGESTION_CONCURRENCY: positiveInt.max(16).default(2),
  })
  .refine((env) => env.CHUNK_OVERLAP < env.CHUNK_SIZE, {
    message: 'CHUNK_OVERLAP must be smaller than CHUNK_SIZE',
    path: ['CHUNK_OVERLAP'],
  })
  // The question is the retrieval query, so it must pass the query limit as well.
  .refine((env) => (env.MAX_QUESTION_CHARS ?? 0) <= env.MAX_QUERY_CHARS, {
    message: 'MAX_QUESTION_CHARS must not be larger than MAX_QUERY_CHARS',
    path: ['MAX_QUESTION_CHARS'],
  })
  .refine((env) => env.MAX_UPLOAD_REQUEST_BYTES >= env.MAX_UPLOAD_BYTES, {
    message: 'MAX_UPLOAD_REQUEST_BYTES must not be smaller than MAX_UPLOAD_BYTES',
    path: ['MAX_UPLOAD_REQUEST_BYTES'],
  });

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  logLevel: string;
  server: {
    host: string;
    port: number;
    corsOrigins: string[];
    /** Accepted `Host` names (lower case, without port); `null` = any host (`ALLOWED_HOSTS=*`). */
    allowedHosts: string[] | null;
    /** Another layer restricts network access (`NETWORK_ACCESS_PROTECTED`). */
    networkAccessProtected: boolean;
    /** Swagger UI and OpenAPI JSON under /api/docs (`API_DOCS_ENABLED`). */
    docsEnabled: boolean;
    /** Maximum time to receive a complete request in ms (`REQUEST_TIMEOUT_MS`). */
    requestTimeoutMs: number;
  };
  security: {
    rateLimit: {
      enabled: boolean;
      windowMs: number;
      /** Requests per window for every route without a stricter limit. */
      max: number;
      uploadMax: number;
      chatMax: number;
      /** Retrieval search and playground search (each route has its own counter). */
      searchMax: number;
    };
    /** Chat requests processed at the same time (`MAX_CONCURRENT_CHATS`). */
    maxConcurrentChats: number;
  };
  database: { url: string; poolMax: number };
  ollama: { baseUrl: string };
  embedding: {
    provider: 'ollama';
    model: string;
    dimensions: number;
    /** Texts per provider request (`EMBEDDING_BATCH_SIZE`). */
    batchSize: number;
    /** Timeout of one provider request in milliseconds (`EMBEDDING_TIMEOUT_MS`). */
    timeoutMs: number;
  };
  chat: {
    provider: 'ollama';
    model: string;
    /** Maximum wait for the next streamed piece of an answer in ms (`CHAT_TIMEOUT_MS`). */
    timeoutMs: number;
    /** Characters of all source blocks in one prompt (`CHAT_CONTEXT_CHAR_BUDGET`). */
    contextCharBudget: number;
    /** Maximum question length in characters after trimming (`MAX_QUESTION_CHARS`). */
    maxQuestionChars: number;
  };
  retrieval: {
    /** `topK` when a request omits it (`RETRIEVAL_TOP_K`, 1..100). */
    defaultTopK: number;
    /** Maximum query length in characters after trimming (`MAX_QUERY_CHARS`). */
    maxQueryChars: number;
  };
  chunking: { targetSize: number; overlap: number };
  upload: {
    maxFileBytes: number;
    maxFiles: number;
    /** Total bytes of all files of one request (`MAX_UPLOAD_REQUEST_BYTES`). */
    maxRequestBytes: number;
    /** `MAX_DOCUMENTS_PER_COLLECTION`; `null` = unlimited. */
    maxDocumentsPerCollection: number | null;
  };
  ingestion: { concurrency: number };
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Parses and validates environment variables. Throws a {@link ConfigError} listing every problem. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  // Treat empty strings like unset variables so `.env` lines such as `API_PORT=` fall back to defaults.
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ''),
  );
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const env = result.data;
  return {
    env: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    server: {
      host: env.API_HOST,
      port: env.API_PORT,
      corsOrigins: env.CORS_ORIGINS,
      allowedHosts: env.ALLOWED_HOSTS.includes('*')
        ? null
        : env.ALLOWED_HOSTS.map((host) => host.toLowerCase()),
      networkAccessProtected: env.NETWORK_ACCESS_PROTECTED,
      docsEnabled: env.API_DOCS_ENABLED,
      requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    },
    security: {
      rateLimit: {
        enabled: env.RATE_LIMIT_ENABLED,
        windowMs: env.RATE_LIMIT_WINDOW_MS,
        max: env.RATE_LIMIT_MAX,
        uploadMax: env.RATE_LIMIT_UPLOAD_MAX,
        chatMax: env.RATE_LIMIT_CHAT_MAX,
        searchMax: env.RATE_LIMIT_SEARCH_MAX,
      },
      maxConcurrentChats: env.MAX_CONCURRENT_CHATS,
    },
    database: { url: env.DATABASE_URL, poolMax: env.DATABASE_POOL_MAX },
    ollama: { baseUrl: env.OLLAMA_BASE_URL },
    embedding: {
      provider: env.EMBEDDING_PROVIDER,
      model: env.EMBEDDING_MODEL,
      dimensions: env.EMBEDDING_DIMENSIONS,
      batchSize: env.EMBEDDING_BATCH_SIZE,
      timeoutMs: env.EMBEDDING_TIMEOUT_MS,
    },
    chat: {
      provider: env.CHAT_PROVIDER,
      model: env.CHAT_MODEL,
      timeoutMs: env.CHAT_TIMEOUT_MS,
      contextCharBudget: env.CHAT_CONTEXT_CHAR_BUDGET,
      maxQuestionChars:
        env.MAX_QUESTION_CHARS ?? Math.min(DEFAULT_MAX_QUESTION_CHARS, env.MAX_QUERY_CHARS),
    },
    retrieval: { defaultTopK: env.RETRIEVAL_TOP_K, maxQueryChars: env.MAX_QUERY_CHARS },
    chunking: { targetSize: env.CHUNK_SIZE, overlap: env.CHUNK_OVERLAP },
    upload: {
      maxFileBytes: env.MAX_UPLOAD_BYTES,
      maxFiles: env.MAX_UPLOAD_FILES,
      maxRequestBytes: env.MAX_UPLOAD_REQUEST_BYTES,
      maxDocumentsPerCollection: env.MAX_DOCUMENTS_PER_COLLECTION ?? null,
    },
    ingestion: { concurrency: env.INGESTION_CONCURRENCY },
  };
}
