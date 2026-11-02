import type { AppConfig } from '../../config/env.js';
import type { ChatProvider } from './chat-provider.js';
import { OllamaChatProvider } from './ollama-chat-provider.js';

export interface ChatProviderConfig {
  chat: AppConfig['chat'];
  ollama: AppConfig['ollama'];
}

/**
 * The only place that maps `CHAT_PROVIDER` to an adapter. Everything else works with the
 * {@link ChatProvider} interface.
 */
export function createChatProvider(
  config: ChatProviderConfig,
  { fetch }: { fetch?: typeof globalThis.fetch } = {},
): ChatProvider {
  const { chat } = config;
  switch (chat.provider) {
    case 'ollama':
      return new OllamaChatProvider({
        baseUrl: config.ollama.baseUrl,
        model: chat.model,
        timeoutMs: chat.timeoutMs,
        ...(fetch ? { fetch } : {}),
      });
    default: {
      // Unreachable while the configuration schema only accepts known providers.
      const unknown: never = chat.provider;
      throw new Error(`Unknown chat provider: ${String(unknown)}`);
    }
  }
}
