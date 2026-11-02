import type { AppConfig } from '../../config/env.js';
import type { EmbeddingProvider } from './embedding-provider.js';
import { OllamaEmbeddingProvider } from './ollama-embedding-provider.js';

export interface EmbeddingProviderConfig {
  embedding: AppConfig['embedding'];
  ollama: AppConfig['ollama'];
}

/**
 * The only place that maps `EMBEDDING_PROVIDER` to an adapter. Everything else works with the
 * {@link EmbeddingProvider} interface.
 */
export function createEmbeddingProvider(
  config: EmbeddingProviderConfig,
  { fetch }: { fetch?: typeof globalThis.fetch } = {},
): EmbeddingProvider {
  const { embedding } = config;
  switch (embedding.provider) {
    case 'ollama':
      return new OllamaEmbeddingProvider({
        baseUrl: config.ollama.baseUrl,
        model: embedding.model,
        dimensions: embedding.dimensions,
        batchSize: embedding.batchSize,
        timeoutMs: embedding.timeoutMs,
        ...(fetch ? { fetch } : {}),
      });
    default: {
      // Unreachable while the configuration schema only accepts known providers.
      const unknown: never = embedding.provider;
      throw new Error(`Unknown embedding provider: ${String(unknown)}`);
    }
  }
}
