import type {
  ChatProviderStatusDto,
  EmbeddingProviderStatusDto,
  ProvidersStatusResponse,
} from '@raglab/shared';
import type { ChatProvider } from '../chat/chat-provider.js';
import { EmbeddingProviderError, type EmbeddingProvider } from './embedding-provider.js';

/** Text of the optional test embedding (`?verify=true`); contains no user data. */
export const VERIFY_TEXT = 'RAGLab embedding dimension check';

export interface ProviderStatusService {
  /**
   * Reports honest provider state: reachability and model availability are checked live,
   * the output dimension only when `verify` is set (one test embedding, costs compute time).
   */
  status(options?: { verify?: boolean; signal?: AbortSignal }): Promise<ProvidersStatusResponse>;
}

interface VerifyResult {
  verification: EmbeddingProviderStatusDto['verification'];
  /** Observed vector length of the test embedding. */
  verified?: number;
}

export interface ProviderStatusServiceDependencies {
  embedding: EmbeddingProvider;
  /** Chat provider: reachability and model only (the check generates nothing). */
  chat: ChatProvider;
  /** Dimension of `chunks.embedding` from the database catalog; `null` if unknown. */
  columnDimensions(): Promise<number | null>;
}

export function createProviderStatusService({
  embedding,
  chat,
  columnDimensions,
}: ProviderStatusServiceDependencies): ProviderStatusService {
  async function readColumn(): Promise<number | null> {
    try {
      return await columnDimensions();
    } catch {
      // Database problems are reported by the readiness check.
      return null;
    }
  }

  async function verify(signal?: AbortSignal): Promise<VerifyResult> {
    const started = performance.now();
    const durationMs = () => Math.round(performance.now() - started);
    try {
      const [vector] = await embedding.embed([VERIFY_TEXT], signal);
      return {
        verification: { status: 'passed', durationMs: durationMs() },
        ...(vector ? { verified: vector.length } : {}),
      };
    } catch (error) {
      if (!(error instanceof EmbeddingProviderError)) {
        throw error;
      }
      return {
        verification: {
          status: 'failed',
          code: error.code,
          error: error.userMessage,
          durationMs: durationMs(),
        },
        // A wrong dimension was observed – report it, it is a real measurement.
        ...(error.details.actual !== undefined ? { verified: error.details.actual } : {}),
      };
    }
  }

  return {
    async status({ verify: shouldVerify = false, signal } = {}) {
      const [check, column, chatCheck] = await Promise.all([
        embedding.checkStatus(signal),
        readColumn(),
        chat.checkStatus(signal),
      ]);
      const verification: VerifyResult = shouldVerify
        ? await verify(signal)
        : { verification: { status: 'skipped' } };
      return {
        embedding: {
          provider: embedding.id,
          model: embedding.model,
          reachable: check.reachable,
          modelAvailable: check.modelAvailable,
          dimensions: {
            configured: embedding.dimensions,
            column,
            ...(verification.verified !== undefined ? { verified: verification.verified } : {}),
          },
          verification: verification.verification,
          ...(check.error ? { error: check.error } : {}),
          ...(check.hint ? { hint: check.hint } : {}),
        },
        chat: chatStatus(chat, chatCheck),
        checkedAt: new Date().toISOString(),
      };
    },
  };
}

function chatStatus(
  chat: ChatProvider,
  check: Awaited<ReturnType<ChatProvider['checkStatus']>>,
): ChatProviderStatusDto {
  return {
    provider: chat.id,
    model: chat.model,
    reachable: check.reachable,
    modelAvailable: check.modelAvailable,
    ...(check.error ? { error: check.error } : {}),
    ...(check.hint ? { hint: check.hint } : {}),
  };
}
