import {
  assertEmbeddings,
  EmbeddingProviderError,
  type EmbeddingProvider,
  type EmbeddingProviderStatus,
} from './embedding-provider.js';

export const OLLAMA_PROVIDER_ID = 'ollama';

/** Status checks (`GET /api/tags`) are cheap; they never wait as long as an embedding request. */
const STATUS_TIMEOUT_MS = 5000;

/** Provider error texts are shortened before they reach users or logs. */
const MAX_ERROR_TEXT = 200;

export interface OllamaEmbeddingProviderOptions {
  /** `OLLAMA_BASE_URL`, e.g. `http://localhost:11434`. */
  baseUrl: string;
  model: string;
  dimensions: number;
  /** Texts per `POST /api/embed` request (`EMBEDDING_BATCH_SIZE`). */
  batchSize: number;
  /** Timeout of one request in milliseconds (`EMBEDDING_TIMEOUT_MS`). */
  timeoutMs: number;
  /** Replaceable for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export const OLLAMA_UNREACHABLE_HINT =
  'Make sure Ollama is running (ollama serve) and OLLAMA_BASE_URL is correct.';
export const ollamaPullHint = (model: string) => `Run "ollama pull ${model}" on the Ollama host.`;

/**
 * Embedding adapter for Ollama's REST API, called with `fetch` (no SDK, ADR 0001):
 * `POST /api/embed` with `{ model, input: string[] }` → `{ embeddings: number[][] }`, and
 * `GET /api/tags` → `{ models: [{ name, model, … }] }` for the status check.
 *
 * Inputs longer than the model's context are truncated by Ollama (its default `truncate: true`).
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id = OLLAMA_PROVIDER_ID;
  readonly model: string;
  readonly dimensions: number;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;

  constructor(options: OllamaEmbeddingProviderOptions) {
    if (!Number.isInteger(options.batchSize) || options.batchSize < 1) {
      throw new Error('OllamaEmbeddingProvider needs a batch size of at least 1');
    }
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.batchSize = options.batchSize;
    this.timeoutMs = options.timeoutMs;
    this.baseUrl = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += this.batchSize) {
      signal?.throwIfAborted();
      const batch = texts.slice(start, start + this.batchSize);
      vectors.push(...(await this.embedBatch(batch, signal)));
    }
    return vectors;
  }

  async checkStatus(signal?: AbortSignal): Promise<EmbeddingProviderStatus> {
    let body: unknown;
    try {
      body = await this.request(
        'api/tags',
        { method: 'GET' },
        Math.min(this.timeoutMs, STATUS_TIMEOUT_MS),
        signal,
      );
    } catch (error) {
      if (error instanceof EmbeddingProviderError) {
        return {
          reachable: false,
          modelAvailable: null,
          error: error.message,
          ...(error.details.hint ? { hint: error.details.hint } : {}),
        };
      }
      throw error;
    }
    const models = (body as { models?: unknown } | null)?.models;
    if (!Array.isArray(models)) {
      return {
        reachable: true,
        modelAvailable: null,
        error: 'Ollama returned an unexpected model list.',
      };
    }
    const modelAvailable = isOllamaModelListed(models, this.model);
    return modelAvailable
      ? { reachable: true, modelAvailable }
      : {
          reachable: true,
          modelAvailable,
          error: `Embedding model "${this.model}" is not installed in Ollama.`,
          hint: ollamaPullHint(this.model),
        };
  }

  private async embedBatch(batch: string[], signal?: AbortSignal): Promise<number[][]> {
    const body = await this.request(
      'api/embed',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: batch }),
      },
      this.timeoutMs,
      signal,
    );
    const embeddings = (body as { embeddings?: unknown } | null)?.embeddings;
    assertEmbeddings(embeddings, batch.length, this.dimensions, `Ollama model "${this.model}"`);
    return embeddings;
  }

  /** Performs one request with timeout + external abort and maps failures to provider errors. */
  private async request(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort(new Error('timeout'));
    }, timeoutMs);
    const combined = signal ? AbortSignal.any([timeout.signal, signal]) : timeout.signal;
    try {
      const response = await this.fetch(new URL(path, this.baseUrl), {
        ...init,
        signal: combined,
      });
      const text = await response.text();
      if (!response.ok) {
        throw this.httpError(response.status, text);
      }
      try {
        return JSON.parse(text) as unknown;
      } catch (cause) {
        throw new EmbeddingProviderError(
          'PROVIDER_ERROR',
          'Ollama returned a response that is not valid JSON.',
          {},
          { cause },
        );
      }
    } catch (error) {
      if (signal?.aborted) {
        // Shutdown or client abort – not a provider failure.
        throw signal.reason;
      }
      if (error instanceof EmbeddingProviderError) {
        throw error;
      }
      if (timeout.signal.aborted) {
        throw new EmbeddingProviderError(
          'PROVIDER_TIMEOUT',
          `Ollama did not answer within ${timeoutMs} ms.`,
          {
            hint: 'Check the Ollama host or increase EMBEDDING_TIMEOUT_MS (the first request also loads the model).',
          },
          { cause: error },
        );
      }
      throw new EmbeddingProviderError(
        'PROVIDER_UNREACHABLE',
        'Ollama is not reachable.',
        { hint: OLLAMA_UNREACHABLE_HINT },
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private httpError(status: number, text: string): EmbeddingProviderError {
    const providerMessage = extractOllamaErrorText(text);
    if (status === 404 || /model .*not found/i.test(providerMessage)) {
      return new EmbeddingProviderError(
        'MODEL_NOT_FOUND',
        `Embedding model "${this.model}" is not installed in Ollama.`,
        { hint: ollamaPullHint(this.model), status },
      );
    }
    return new EmbeddingProviderError(
      'PROVIDER_ERROR',
      `Ollama answered with HTTP ${status}${providerMessage ? `: ${providerMessage}` : '.'}`,
      { status },
    );
  }
}

/**
 * True if `model` is in the `models` list of `GET /api/tags`. Ollama lists models with their
 * tag; a model configured without a tag means `:latest`. Shared with the chat adapter.
 */
export function isOllamaModelListed(models: readonly unknown[], model: string): boolean {
  const wanted = model.includes(':') ? [model] : [model, `${model}:latest`];
  return models.some((entry) => {
    const { name, model: id } = (entry ?? {}) as { name?: unknown; model?: unknown };
    return wanted.some((candidate) => candidate === name || candidate === id);
  });
}

/**
 * Ollama reports errors as `{ "error": "…" }`; anything else is shortened plain text. Shared with
 * the chat adapter.
 */
export function extractOllamaErrorText(text: string): string {
  let message = text;
  try {
    const parsed = JSON.parse(text) as { error?: unknown } | null;
    if (typeof parsed?.error === 'string') {
      message = parsed.error;
    }
  } catch {
    // not JSON – use the raw text
  }
  const singleLine = message.replace(/\s+/g, ' ').trim();
  return singleLine.length > MAX_ERROR_TEXT
    ? `${singleLine.slice(0, MAX_ERROR_TEXT)}…`
    : singleLine;
}
