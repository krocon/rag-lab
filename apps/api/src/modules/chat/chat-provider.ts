/**
 * Provider-neutral chat abstraction (docs/architecture.md §5). Nothing outside the factory
 * (`create-chat-provider.ts`) and the adapters knows concrete provider ids.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatProvider {
  /** Provider id from the configuration (`CHAT_PROVIDER`). */
  readonly id: string;
  /** Model name from the configuration (`CHAT_MODEL`). */
  readonly model: string;
  /**
   * Streams the answer to `messages` as text pieces in order. Throws a {@link ChatProviderError}
   * on provider failures (also in the middle of the stream); when `signal` aborts, it rejects
   * with the signal's reason. Stopping the iteration early cancels the provider request.
   */
  stream(messages: readonly ChatMessage[], signal?: AbortSignal): AsyncIterable<string>;
  /**
   * Cheap availability check without generating anything (e.g. Ollama `GET /api/tags`).
   * Never throws; problems are reported in the result.
   */
  checkStatus(signal?: AbortSignal): Promise<ChatProviderStatus>;
}

export interface ChatProviderStatus {
  reachable: boolean;
  /** `null` when unknown (provider not reachable). */
  modelAvailable: boolean | null;
  /** Human-readable problem description (no secrets). */
  error?: string;
  /** What the user can do about it, e.g. `ollama pull <model>`. */
  hint?: string;
}

export const CHAT_PROVIDER_ERROR_CODES = [
  'PROVIDER_UNREACHABLE',
  'MODEL_NOT_FOUND',
  'PROVIDER_TIMEOUT',
  'PROVIDER_ERROR',
] as const;

export type ChatProviderErrorCode = (typeof CHAT_PROVIDER_ERROR_CODES)[number];

/**
 * Failure of a chat provider. `message` (and `hint`) are safe to show to users: they never
 * contain prompt text, document content, credentials or stack traces. Details go to `cause`.
 */
export class ChatProviderError extends Error {
  constructor(
    readonly code: ChatProviderErrorCode,
    message: string,
    readonly details: { hint?: string; status?: number } = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ChatProviderError';
  }

  /** The message plus the hint, if any – meant for users. */
  get userMessage(): string {
    return this.details.hint ? `${this.message} ${this.details.hint}` : this.message;
  }
}
