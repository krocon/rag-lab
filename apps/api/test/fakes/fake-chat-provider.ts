import {
  ChatProviderError,
  type ChatMessage,
  type ChatProvider,
  type ChatProviderStatus,
} from '../../src/modules/chat/chat-provider.js';

export interface FakeChatProviderOptions {
  id?: string;
  model?: string;
  /** Answer pieces streamed in order. */
  tokens?: readonly string[];
  /** Error thrown after `failAfter` tokens (default: before the first token). */
  failWith?: ChatProviderError | Error;
  failAfter?: number;
  /** Delay before each token in ms (e.g. to abort in the middle). */
  delayMs?: number;
  /** Throw if `stream` is called at all – for paths that must not reach the model. */
  forbidCalls?: boolean;
  status?: ChatProviderStatus;
}

export interface FakeChatCall {
  messages: ChatMessage[];
  signal: AbortSignal | undefined;
}

export interface FakeChatProvider extends ChatProvider {
  /** Every `stream` call with its messages and signal. */
  readonly calls: FakeChatCall[];
  tokens: readonly string[];
  failWith: ChatProviderError | Error | undefined;
  status: ChatProviderStatus;
  /** Resolves when the signal of a call aborted while streaming. */
  readonly aborted: Promise<unknown>;
}

/** In-test chat provider: no network, scripted tokens, optional failures and delays. */
export function createFakeChatProvider({
  id = 'ollama',
  model = 'test-chat-model',
  tokens = ['The answer ', 'is 42 ', '[1].'],
  failWith,
  failAfter = 0,
  delayMs = 0,
  forbidCalls = false,
  status = { reachable: true, modelAvailable: true },
}: FakeChatProviderOptions = {}): FakeChatProvider {
  const calls: FakeChatCall[] = [];
  let resolveAborted: (reason: unknown) => void = () => undefined;
  const aborted = new Promise<unknown>((resolve) => (resolveAborted = resolve));
  return {
    id,
    model,
    calls,
    tokens,
    failWith,
    status,
    aborted,
    async *stream(messages, signal) {
      if (forbidCalls) {
        throw new Error('the chat provider must not be called');
      }
      calls.push({ messages: [...messages], signal });
      signal?.addEventListener('abort', () => resolveAborted(signal.reason), { once: true });
      signal?.throwIfAborted();
      for (const [index, token] of this.tokens.entries()) {
        if (this.failWith && index === failAfter) {
          throw this.failWith;
        }
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        signal?.throwIfAborted();
        yield token;
      }
      if (this.failWith && failAfter >= this.tokens.length) {
        throw this.failWith;
      }
    },
    async checkStatus() {
      return this.status;
    },
  };
}

export const chatModelNotFound = (model = 'test-chat-model') =>
  new ChatProviderError('MODEL_NOT_FOUND', `Chat model "${model}" is not installed in Ollama.`, {
    hint: `Run "ollama pull ${model}" on the Ollama host.`,
  });
