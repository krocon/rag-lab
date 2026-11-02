import {
  extractOllamaErrorText,
  isOllamaModelListed,
  OLLAMA_PROVIDER_ID,
  OLLAMA_UNREACHABLE_HINT,
  ollamaPullHint,
} from '../embeddings/ollama-embedding-provider.js';
import {
  ChatProviderError,
  type ChatMessage,
  type ChatProvider,
  type ChatProviderStatus,
} from './chat-provider.js';
import { NdjsonParseError, parseNdjson } from './ndjson.js';

/** Status checks (`GET /api/tags`) are cheap; they never wait as long as an answer. */
const STATUS_TIMEOUT_MS = 5000;

export interface OllamaChatProviderOptions {
  /** `OLLAMA_BASE_URL`, e.g. `http://localhost:11434`. */
  baseUrl: string;
  model: string;
  /**
   * Maximum wait in ms for the response headers and then for each next line of the stream
   * (`CHAT_TIMEOUT_MS`) – an idle timeout, not a limit for the whole answer.
   */
  timeoutMs: number;
  /** Replaceable for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** One line of Ollama's `POST /api/chat` stream (only the fields RAGLab reads). */
interface OllamaChatLine {
  message?: { role?: unknown; content?: unknown };
  done?: unknown;
  error?: unknown;
}

/**
 * Chat adapter for Ollama's REST API, called with `fetch` (no SDK, ADR 0001):
 * `POST /api/chat` with `{ model, messages, stream: true }` answers with newline-delimited JSON:
 * `{ message: { role, content }, done: false }` per piece, then a final line with `done: true`
 * (plus `done_reason` and durations). Errors before the stream are HTTP errors with
 * `{ error }` (missing model: `404 {"error":"model 'x' not found"}`, checked against Ollama
 * 0.40.13); errors during the stream arrive as a line `{ error }`.
 */
export class OllamaChatProvider implements ChatProvider {
  readonly id = OLLAMA_PROVIDER_ID;
  readonly model: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;

  constructor(options: OllamaChatProviderOptions) {
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.baseUrl = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async *stream(messages: readonly ChatMessage[], signal?: AbortSignal): AsyncGenerator<string> {
    signal?.throwIfAborted();
    // Aborted by the idle timeout and in `finally` (error, end, or the consumer stopped early),
    // so the HTTP request never outlives the iteration.
    const internal = new AbortController();
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const armTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        internal.abort(new Error('timeout'));
      }, this.timeoutMs);
    };
    const combined = signal ? AbortSignal.any([internal.signal, signal]) : internal.signal;
    const fail = (error: unknown, phase: 'connect' | 'stream') =>
      this.toFailure(error, phase, signal, timedOut);

    armTimeout();
    try {
      let response: Response;
      try {
        response = await this.fetch(new URL('api/chat', this.baseUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            messages: messages.map(({ role, content }) => ({ role, content })),
            stream: true,
          }),
          signal: combined,
        });
      } catch (error) {
        throw fail(error, 'connect');
      }

      if (!response.ok) {
        let text = '';
        try {
          text = await response.text();
        } catch (error) {
          throw fail(error, 'stream');
        }
        throw this.errorFromText(text, response.status);
      }
      if (!response.body) {
        throw new ChatProviderError('PROVIDER_ERROR', 'Ollama returned an empty response.');
      }

      let finished = false;
      const lines = parseNdjson(response.body as unknown as AsyncIterable<Uint8Array>);
      try {
        for await (const value of lines) {
          armTimeout();
          const line = (value ?? {}) as OllamaChatLine;
          if (typeof line.error === 'string') {
            throw this.errorFromText(JSON.stringify({ error: line.error }));
          }
          const content = line.message?.content;
          if (typeof content === 'string' && content.length > 0) {
            yield content;
          }
          if (line.done === true) {
            finished = true;
            break;
          }
        }
      } catch (error) {
        throw fail(error, 'stream');
      }
      if (!finished) {
        throw new ChatProviderError(
          'PROVIDER_ERROR',
          'Ollama ended the answer stream unexpectedly.',
        );
      }
    } finally {
      clearTimeout(timer);
      internal.abort(new Error('chat stream finished'));
    }
  }

  async checkStatus(signal?: AbortSignal): Promise<ChatProviderStatus> {
    const timeout = AbortSignal.timeout(Math.min(this.timeoutMs, STATUS_TIMEOUT_MS));
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    let body: unknown;
    try {
      const response = await this.fetch(new URL('api/tags', this.baseUrl), {
        method: 'GET',
        signal: combined,
      });
      const text = await response.text();
      if (!response.ok) {
        const message = extractOllamaErrorText(text);
        return {
          reachable: true,
          modelAvailable: null,
          error: `Ollama answered with HTTP ${response.status}${message ? `: ${message}` : '.'}`,
        };
      }
      body = JSON.parse(text) as unknown;
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason;
      }
      return error instanceof SyntaxError
        ? {
            reachable: true,
            modelAvailable: null,
            error: 'Ollama returned an unexpected model list.',
          }
        : timeout.aborted
          ? {
              reachable: false,
              modelAvailable: null,
              error: `Ollama did not answer within ${Math.min(this.timeoutMs, STATUS_TIMEOUT_MS)} ms.`,
              hint: OLLAMA_UNREACHABLE_HINT,
            }
          : {
              reachable: false,
              modelAvailable: null,
              error: 'Ollama is not reachable.',
              hint: OLLAMA_UNREACHABLE_HINT,
            };
    }
    const models = (body as { models?: unknown } | null)?.models;
    if (!Array.isArray(models)) {
      return {
        reachable: true,
        modelAvailable: null,
        error: 'Ollama returned an unexpected model list.',
      };
    }
    return isOllamaModelListed(models, this.model)
      ? { reachable: true, modelAvailable: true }
      : {
          reachable: true,
          modelAvailable: false,
          error: `Chat model "${this.model}" is not installed in Ollama.`,
          hint: ollamaPullHint(this.model),
        };
  }

  /** Maps an Ollama error text (HTTP body or stream line) to a provider error. */
  private errorFromText(text: string, status?: number): ChatProviderError {
    const providerMessage = extractOllamaErrorText(text);
    const details = status === undefined ? {} : { status };
    if (status === 404 || /model .*not found/i.test(providerMessage)) {
      return new ChatProviderError(
        'MODEL_NOT_FOUND',
        `Chat model "${this.model}" is not installed in Ollama.`,
        { hint: ollamaPullHint(this.model), ...details },
      );
    }
    const prefix =
      status === undefined ? 'Ollama reported an error' : `Ollama answered with HTTP ${status}`;
    return new ChatProviderError(
      'PROVIDER_ERROR',
      `${prefix}${providerMessage ? `: ${providerMessage}` : '.'}`,
      details,
    );
  }

  /** Turns anything thrown while talking to Ollama into the error the caller should see. */
  private toFailure(
    error: unknown,
    phase: 'connect' | 'stream',
    signal: AbortSignal | undefined,
    timedOut: boolean,
  ): unknown {
    if (signal?.aborted) {
      // Client abort or shutdown – not a provider failure.
      return signal.reason;
    }
    if (error instanceof ChatProviderError) {
      return error;
    }
    if (error instanceof NdjsonParseError) {
      return new ChatProviderError(
        'PROVIDER_ERROR',
        'Ollama returned an answer stream that is not valid JSON.',
        {},
        { cause: error },
      );
    }
    if (timedOut) {
      return new ChatProviderError(
        'PROVIDER_TIMEOUT',
        `Ollama did not send the next part of the answer within ${this.timeoutMs} ms.`,
        {
          hint: 'Check the Ollama host or increase CHAT_TIMEOUT_MS (the first request also loads the model).',
        },
        { cause: error },
      );
    }
    return phase === 'connect'
      ? new ChatProviderError(
          'PROVIDER_UNREACHABLE',
          'Ollama is not reachable.',
          { hint: OLLAMA_UNREACHABLE_HINT },
          { cause: error },
        )
      : new ChatProviderError(
          'PROVIDER_ERROR',
          'The connection to Ollama was interrupted while streaming the answer.',
          {},
          { cause: error },
        );
  }
}
