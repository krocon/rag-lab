/**
 * Provider-neutral embedding abstraction (docs/architecture.md §5). Nothing outside the factory
 * (`create-embedding-provider.ts`) and the adapters knows concrete provider ids.
 */
export interface EmbeddingProvider {
  /** Provider id from the configuration (`EMBEDDING_PROVIDER`), stored per collection. */
  readonly id: string;
  /** Model name from the configuration (`EMBEDDING_MODEL`). */
  readonly model: string;
  /** Expected vector length (`EMBEDDING_DIMENSIONS`); every response is checked against it. */
  readonly dimensions: number;
  /**
   * Embeds `texts` and returns exactly one vector of length {@link dimensions} per text, in input
   * order. Throws an {@link EmbeddingProviderError} on provider failures; when `signal` aborts,
   * it rejects with the signal's reason (not with a provider error).
   */
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
  /**
   * Cheap availability check without embedding anything (e.g. Ollama `GET /api/tags`).
   * Never throws; problems are reported in the result.
   */
  checkStatus(signal?: AbortSignal): Promise<EmbeddingProviderStatus>;
}

export interface EmbeddingProviderStatus {
  reachable: boolean;
  /** `null` when unknown (provider not reachable). */
  modelAvailable: boolean | null;
  /** Human-readable problem description (no secrets). */
  error?: string;
  /** What the user can do about it, e.g. `ollama pull <model>`. */
  hint?: string;
}

export const EMBEDDING_PROVIDER_ERROR_CODES = [
  'PROVIDER_UNREACHABLE',
  'MODEL_NOT_FOUND',
  'DIMENSION_MISMATCH',
  'PROVIDER_TIMEOUT',
  'PROVIDER_ERROR',
] as const;

export type EmbeddingProviderErrorCode = (typeof EMBEDDING_PROVIDER_ERROR_CODES)[number];

/**
 * Failure of an embedding provider. `message` (and `hint`) are safe to show to users: they never
 * contain the embedded texts, credentials or stack traces. Technical details go to `cause`.
 */
export class EmbeddingProviderError extends Error {
  constructor(
    readonly code: EmbeddingProviderErrorCode,
    message: string,
    readonly details: { hint?: string; expected?: number; actual?: number; status?: number } = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'EmbeddingProviderError';
  }

  /** The message plus the hint, if any – meant for users (e.g. `documents.error_message`). */
  get userMessage(): string {
    return this.details.hint ? `${this.message} ${this.details.hint}` : this.message;
  }
}

/**
 * Validates a provider response: one vector per input, each of exactly `dimensions` finite
 * numbers. Wrong vectors are rejected, never truncated or padded.
 */
export function assertEmbeddings(
  vectors: unknown,
  expectedCount: number,
  dimensions: number,
  label = 'The embedding provider',
): asserts vectors is number[][] {
  if (!Array.isArray(vectors)) {
    throw new EmbeddingProviderError('PROVIDER_ERROR', `${label} returned no embeddings.`);
  }
  if (vectors.length !== expectedCount) {
    throw new EmbeddingProviderError(
      'PROVIDER_ERROR',
      `${label} returned ${vectors.length} embeddings for ${expectedCount} texts.`,
    );
  }
  for (const vector of vectors) {
    if (!Array.isArray(vector)) {
      throw new EmbeddingProviderError(
        'PROVIDER_ERROR',
        `${label} returned a malformed embedding.`,
      );
    }
    if (vector.length !== dimensions) {
      throw new EmbeddingProviderError(
        'DIMENSION_MISMATCH',
        `${label} returned vectors with ${vector.length} dimensions, but EMBEDDING_DIMENSIONS is ${dimensions}.`,
        {
          expected: dimensions,
          actual: vector.length,
          hint: 'Set EMBEDDING_DIMENSIONS to the dimension of the model or use a model with matching dimensions.',
        },
      );
    }
    if (!vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      throw new EmbeddingProviderError(
        'PROVIDER_ERROR',
        `${label} returned an embedding with non-numeric values.`,
      );
    }
  }
}
