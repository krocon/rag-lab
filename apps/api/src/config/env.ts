import { z } from 'zod';

/**
 * pgvector can build an HNSW index on `vector` columns only up to 2,000 dimensions
 * (`halfvec`: 4,000). Larger embeddings need a schema change, see docs/adr/0002-rag-pipeline.md.
 */
export const MAX_INDEXABLE_VECTOR_DIMENSIONS = 2000;

const port = z.coerce.number().int().min(1).max(65_535);
const positiveInt = z.coerce.number().int().positive();

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PORT: port.default(3000),
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:4200')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0),
      ),

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
    CHAT_PROVIDER: z.enum(['ollama']).default('ollama'),
    CHAT_MODEL: z.string().min(1, 'CHAT_MODEL is required'),

    RETRIEVAL_TOP_K: positiveInt.max(100).default(8),
    CHUNK_SIZE: positiveInt.default(1200),
    CHUNK_OVERLAP: z.coerce.number().int().min(0).default(200),
  })
  .refine((env) => env.CHUNK_OVERLAP < env.CHUNK_SIZE, {
    message: 'CHUNK_OVERLAP must be smaller than CHUNK_SIZE',
    path: ['CHUNK_OVERLAP'],
  });

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  logLevel: string;
  server: { host: string; port: number; corsOrigins: string[] };
  database: { url: string; poolMax: number };
  ollama: { baseUrl: string };
  embedding: { provider: 'ollama'; model: string; dimensions: number };
  chat: { provider: 'ollama'; model: string };
  retrieval: { defaultTopK: number };
  chunking: { targetSize: number; overlap: number };
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
    server: { host: env.API_HOST, port: env.API_PORT, corsOrigins: env.CORS_ORIGINS },
    database: { url: env.DATABASE_URL, poolMax: env.DATABASE_POOL_MAX },
    ollama: { baseUrl: env.OLLAMA_BASE_URL },
    embedding: {
      provider: env.EMBEDDING_PROVIDER,
      model: env.EMBEDDING_MODEL,
      dimensions: env.EMBEDDING_DIMENSIONS,
    },
    chat: { provider: env.CHAT_PROVIDER, model: env.CHAT_MODEL },
    retrieval: { defaultTopK: env.RETRIEVAL_TOP_K },
    chunking: { targetSize: env.CHUNK_SIZE, overlap: env.CHUNK_OVERLAP },
  };
}
