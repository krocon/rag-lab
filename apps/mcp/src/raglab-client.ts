import type {
  ApiErrorResponse,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatRequest,
  ChatSource,
  CollectionDto,
  CollectionListResponse,
  DocumentChunksResponse,
  DocumentContentResponse,
  DocumentDto,
  RetrievalSearchRequest,
  RetrievalSearchResponse,
} from '@raglab/shared';
import { CLIENT_ERROR_CODES, RaglabApiError } from './errors.js';
import { readSseStream } from './sse.js';

/** Aggregated result of `POST /api/chat` (all SSE events consumed). */
export interface ChatResult {
  sources: ChatSource[];
  /** Concatenated `token` texts. */
  answer: string;
  /** `done` event; `null` when the stream ended with an `error` event. */
  done: ChatDoneEvent | null;
  /** `error` event of the stream (chat provider failures); `null` on success. */
  error: ChatErrorEvent | null;
}

/**
 * The API operations the MCP tools need. Tests replace it with a fake; `createRaglabClient`
 * implements it with `fetch` against the RAGLab HTTP API.
 */
export interface RaglabClient {
  listCollections(signal?: AbortSignal): Promise<CollectionDto[]>;
  search(request: RetrievalSearchRequest, signal?: AbortSignal): Promise<RetrievalSearchResponse>;
  getDocument(documentId: string, signal?: AbortSignal): Promise<DocumentDto>;
  getDocumentContent(documentId: string, signal?: AbortSignal): Promise<DocumentContentResponse>;
  getDocumentChunks(documentId: string, signal?: AbortSignal): Promise<DocumentChunksResponse>;
  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult>;
}

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export interface RaglabClientOptions {
  /** Base URL without trailing slash (`McpConfig.apiUrl`). */
  apiUrl: string;
  requestTimeoutMs: number;
  chatTimeoutMs: number;
  /** Replaceable for tests; defaults to the global `fetch`. */
  fetch?: FetchFn;
  /** Sent as `User-Agent`. */
  userAgent?: string;
}

/**
 * HTTP client for the RAGLab API. Requests are plain server-to-server calls: no `Origin` header
 * (Node's `fetch` sends none), so the API's CSRF check does not apply, and the `Host` header comes
 * from `apiUrl` and must be in the API's `ALLOWED_HOSTS` (the default loopback names are). The
 * API's rate limits apply to these requests like to any other client.
 */
export function createRaglabClient(options: RaglabClientOptions): RaglabClient {
  const fetchFn: FetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  const userAgent = options.userAgent ?? 'raglab-mcp';
  // Never echo credentials or paths: `apiUrl` has none (validated), the origin is enough.
  const apiOrigin = new URL(options.apiUrl).origin;

  async function send(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    accept: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<{ response: Response; timeout: AbortSignal }> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers: Record<string, string> = { accept, 'user-agent': userAgent };
    const init: RequestInit = { method, headers, signal: combined, redirect: 'error' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    try {
      const response = await fetchFn(`${options.apiUrl}${path}`, init);
      return { response, timeout };
    } catch (error) {
      throw translateFetchError(error, signal, timeout, timeoutMs, apiOrigin);
    }
  }

  async function requestJson<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const { response, timeout } = await send(
      method,
      path,
      body,
      'application/json',
      signal,
      options.requestTimeoutMs,
    );
    if (!response.ok) {
      throw await errorFromResponse(response);
    }
    try {
      return (await response.json()) as T;
    } catch (error) {
      if (signal?.aborted || timeout.aborted) {
        throw translateFetchError(error, signal, timeout, options.requestTimeoutMs, apiOrigin);
      }
      throw new RaglabApiError(
        response.status,
        CLIENT_ERROR_CODES.unexpectedResponse,
        'The RAGLab API returned a response that is not valid JSON.',
      );
    }
  }

  const id = (value: string) => encodeURIComponent(value);

  return {
    async listCollections(signal) {
      const body = await requestJson<CollectionListResponse>(
        'GET',
        '/api/collections',
        undefined,
        signal,
      );
      return body.items;
    },
    search(request, signal) {
      return requestJson('POST', '/api/retrieval/search', request, signal);
    },
    getDocument(documentId, signal) {
      return requestJson('GET', `/api/documents/${id(documentId)}`, undefined, signal);
    },
    getDocumentContent(documentId, signal) {
      return requestJson('GET', `/api/documents/${id(documentId)}/content`, undefined, signal);
    },
    getDocumentChunks(documentId, signal) {
      return requestJson('GET', `/api/documents/${id(documentId)}/chunks`, undefined, signal);
    },
    async chat(request, signal) {
      const { response, timeout } = await send(
        'POST',
        '/api/chat',
        request,
        'text/event-stream',
        signal,
        options.chatTimeoutMs,
      );
      if (!response.ok) {
        throw await errorFromResponse(response);
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/event-stream') || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new RaglabApiError(
          response.status,
          CLIENT_ERROR_CODES.unexpectedResponse,
          'The RAGLab API did not answer the chat request with an event stream.',
        );
      }
      const result: ChatResult = { sources: [], answer: '', done: null, error: null };
      try {
        for await (const message of readSseStream(response.body)) {
          const data = parseEventData(message.data);
          if (message.event === 'sources') {
            result.sources = (data as { sources: ChatSource[] }).sources;
          } else if (message.event === 'token') {
            result.answer += (data as { text: string }).text;
          } else if (message.event === 'done') {
            result.done = data as ChatDoneEvent;
            return result;
          } else if (message.event === 'error') {
            result.error = data as ChatErrorEvent;
            return result;
          }
          // Unknown events are ignored (forward compatibility).
        }
      } catch (error) {
        if (error instanceof RaglabApiError) {
          throw error;
        }
        if (signal?.aborted || timeout.aborted) {
          throw translateFetchError(error, signal, timeout, options.chatTimeoutMs, apiOrigin);
        }
        throw interrupted();
      }
      // The stream ended without `done` or `error` (API stopped or connection lost).
      throw interrupted();
    },
  };
}

function interrupted(): RaglabApiError {
  return new RaglabApiError(
    0,
    CLIENT_ERROR_CODES.streamInterrupted,
    'The connection to the RAGLab API was interrupted before the answer was complete.',
  );
}

function parseEventData(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw new RaglabApiError(
      200,
      CLIENT_ERROR_CODES.unexpectedResponse,
      'The RAGLab API sent an invalid chat event.',
    );
  }
}

/**
 * Maps `fetch` failures: cancellation by the MCP client is rethrown unchanged (the SDK handles
 * it), timeouts and network errors become `RaglabApiError`s with a helpful message.
 */
function translateFetchError(
  error: unknown,
  signal: AbortSignal | undefined,
  timeout: AbortSignal,
  timeoutMs: number,
  apiOrigin: string,
): unknown {
  if (signal?.aborted) {
    return error;
  }
  if (timeout.aborted) {
    return new RaglabApiError(
      0,
      CLIENT_ERROR_CODES.timeout,
      `The RAGLab API at ${apiOrigin} did not answer within ${Math.round(timeoutMs / 1000)} s.`,
    );
  }
  return new RaglabApiError(
    0,
    CLIENT_ERROR_CODES.unreachable,
    `The RAGLab API at ${apiOrigin} is not reachable. Start it (e.g. \`pnpm dev:api\`) or check RAGLAB_API_URL.`,
  );
}

function isApiErrorResponse(body: unknown): body is ApiErrorResponse {
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    return false;
  }
  const error = (body as { error: unknown }).error;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

async function errorFromResponse(response: Response): Promise<RaglabApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (isApiErrorResponse(body)) {
    const { code, message, details } = body.error;
    return new RaglabApiError(response.status, code, message, details);
  }
  return new RaglabApiError(
    response.status,
    CLIENT_ERROR_CODES.unexpectedResponse,
    `The RAGLab API answered with HTTP ${response.status} without an error description.`,
  );
}
