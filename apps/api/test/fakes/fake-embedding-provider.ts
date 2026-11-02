import { createHash } from 'node:crypto';
import {
  EmbeddingProviderError,
  type EmbeddingProvider,
  type EmbeddingProviderStatus,
} from '../../src/modules/embeddings/embedding-provider.js';

/**
 * Deterministic vector for a text: SHA-256-seeded values in [-1, 1], L2-normalised.
 * Same text → same vector, different texts → (practically) different vectors.
 */
export function fakeVector(text: string, dimensions: number): number[] {
  const values: number[] = [];
  let block = 0;
  while (values.length < dimensions) {
    const digest = createHash('sha256').update(`${block}:${text}`).digest();
    for (let offset = 0; offset + 4 <= digest.length && values.length < dimensions; offset += 4) {
      values.push(digest.readUInt32BE(offset) / 0xffffffff - 0.5);
    }
    block++;
  }
  const norm = Math.hypot(...values) || 1;
  return values.map((value) => value / norm);
}

export interface FakeEmbeddingProviderOptions {
  id?: string;
  model?: string;
  dimensions?: number;
  /** Length of the returned vectors; defaults to `dimensions` (set it to simulate a mismatch). */
  outputDimensions?: number;
  /** Error thrown by `embed` (once per call while set). Change it to recover. */
  failWith?: EmbeddingProviderError | Error;
  status?: EmbeddingProviderStatus;
  /** Returns a hand-made vector for a text; falls back to {@link fakeVector} for `undefined`. */
  vectorFor?: (text: string) => number[] | undefined;
}

export interface FakeEmbeddingProvider extends EmbeddingProvider {
  /** Every `embed` call with its texts. */
  readonly calls: string[][];
  failWith: EmbeddingProviderError | Error | undefined;
  status: EmbeddingProviderStatus;
}

/** In-test embedding provider: no network, deterministic vectors, optional failures. */
export function createFakeEmbeddingProvider({
  id = 'ollama',
  model = 'test-embedding-model',
  dimensions = 768,
  outputDimensions,
  failWith,
  status = { reachable: true, modelAvailable: true },
  vectorFor,
}: FakeEmbeddingProviderOptions = {}): FakeEmbeddingProvider {
  const calls: string[][] = [];
  return {
    id,
    model,
    dimensions,
    calls,
    failWith,
    status,
    async embed(texts, signal) {
      signal?.throwIfAborted();
      calls.push([...texts]);
      if (this.failWith) {
        throw this.failWith;
      }
      return texts.map(
        (text) => vectorFor?.(text) ?? fakeVector(text, outputDimensions ?? dimensions),
      );
    },
    async checkStatus() {
      return this.status;
    },
  };
}

export const modelNotFound = (model = 'test-embedding-model') =>
  new EmbeddingProviderError('MODEL_NOT_FOUND', `Embedding model "${model}" is not installed.`, {
    hint: `Run "ollama pull ${model}" on the Ollama host.`,
  });
