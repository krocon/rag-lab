import { describe, expect, it, vi } from 'vitest';
import { ChatProviderError, type ChatMessage } from '../../src/modules/chat/chat-provider.js';
import { createChatProvider } from '../../src/modules/chat/create-chat-provider.js';
import { OllamaChatProvider } from '../../src/modules/chat/ollama-chat-provider.js';
import { testConfig } from '../helpers.js';

const messages: ChatMessage[] = [
  { role: 'system', content: 'rules' },
  { role: 'user', content: 'question' },
];

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const piece = (content: string) =>
  line({ model: 'llama3.2', message: { role: 'assistant', content }, done: false });
const finalLine = line({
  model: 'llama3.2',
  message: { role: 'assistant', content: '' },
  done: true,
  done_reason: 'stop',
  eval_count: 3,
});

/** A streamed response whose body yields the given text chunks. */
function streamResponse(parts: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(encoder.encode(part));
      }
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'application/x-ndjson' } });
}

function provider(fetchImpl: typeof fetch, timeoutMs = 1000) {
  return new OllamaChatProvider({
    baseUrl: 'http://ollama.test:11434',
    model: 'llama3.2',
    timeoutMs,
    fetch: fetchImpl,
  });
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const pieces: string[] = [];
  for await (const text of stream) {
    pieces.push(text);
  }
  return pieces;
}

describe('OllamaChatProvider.stream', () => {
  it('posts the messages with stream: true and yields the content pieces', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      streamResponse([
        piece('Hel'),
        piece('lo'),
        `${piece(' [1]').slice(0, 10)}`,
        piece(' [1]').slice(10),
        finalLine,
      ]),
    );

    const pieces = await collect(provider(fetchMock).stream(messages));

    expect(pieces).toEqual(['Hel', 'lo', ' [1]']);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://ollama.test:11434/api/chat');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'llama3.2', messages, stream: true });
  });

  it('stops at done: true and ignores anything after it', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      streamResponse([piece('a'), finalLine, piece('ignored')]),
    );
    expect(await collect(provider(fetchMock).stream(messages))).toEqual(['a']);
  });

  it('maps HTTP 404 to MODEL_NOT_FOUND with a pull hint', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: "model 'llama3.2' not found" }), { status: 404 }),
    );
    await expect(collect(provider(fetchMock).stream(messages))).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
      message: 'Chat model "llama3.2" is not installed in Ollama.',
      details: { hint: 'Run "ollama pull llama3.2" on the Ollama host.', status: 404 },
    });
  });

  it('maps other HTTP errors to PROVIDER_ERROR with the shortened provider text', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ error: 'x'.repeat(500) }), { status: 500 }),
    );
    const error = await collect(provider(fetchMock).stream(messages)).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'PROVIDER_ERROR', details: { status: 500 } });
    expect((error as Error).message.length).toBeLessThan(260);
  });

  it('reports an error line in the middle of the stream after the earlier pieces', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      streamResponse([piece('partial'), line({ error: 'GPU out of memory' })]),
    );
    const pieces: string[] = [];
    const error = await (async () => {
      for await (const text of provider(fetchMock).stream(messages)) {
        pieces.push(text);
      }
    })().catch((e: unknown) => e);

    expect(pieces).toEqual(['partial']);
    expect(error).toMatchObject({
      code: 'PROVIDER_ERROR',
      message: 'Ollama reported an error: GPU out of memory',
    });
  });

  it('rejects invalid JSON lines as PROVIDER_ERROR', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => streamResponse(['not json\n']));
    await expect(collect(provider(fetchMock).stream(messages))).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: 'Ollama returned an answer stream that is not valid JSON.',
    });
  });

  it('rejects a stream that ends without done: true', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => streamResponse([piece('a')]));
    await expect(collect(provider(fetchMock).stream(messages))).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: 'Ollama ended the answer stream unexpectedly.',
    });
  });

  it('maps a failing connection to PROVIDER_UNREACHABLE', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(collect(provider(fetchMock).stream(messages))).rejects.toMatchObject({
      code: 'PROVIDER_UNREACHABLE',
      details: { hint: expect.stringContaining('OLLAMA_BASE_URL') as unknown },
    });
  });

  it('maps a silent provider to PROVIDER_TIMEOUT', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
        }),
    );
    await expect(collect(provider(fetchMock, 20).stream(messages))).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
      details: { hint: expect.stringContaining('CHAT_TIMEOUT_MS') as unknown },
    });
  });

  it('rejects with the abort reason (not a provider error) when the caller aborts', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const fetchMock = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init?.signal ?? undefined;
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          controller.abort(new Error('client closed the request'));
        }),
    );

    const error = await collect(provider(fetchMock).stream(messages, controller.signal)).catch(
      (e: unknown) => e,
    );

    expect(error).not.toBeInstanceOf(ChatProviderError);
    expect((error as Error).message).toBe('client closed the request');
    expect(seen?.aborted).toBe(true);
  });

  it('aborts the HTTP request when the consumer stops early', async () => {
    let seen: AbortSignal | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      seen = init?.signal ?? undefined;
      return streamResponse([piece('a'), piece('b'), finalLine]);
    });

    for await (const text of provider(fetchMock).stream(messages)) {
      expect(text).toBe('a');
      break;
    }

    expect(seen?.aborted).toBe(true);
  });
});

describe('OllamaChatProvider.checkStatus', () => {
  const tags = (models: unknown) => vi.fn<typeof fetch>(async () => Response.json({ models }));

  it('reports an installed model (":latest" tag)', async () => {
    expect(await provider(tags([{ name: 'llama3.2:latest' }])).checkStatus()).toEqual({
      reachable: true,
      modelAvailable: true,
    });
  });

  it('reports a missing model with a pull hint', async () => {
    expect(await provider(tags([])).checkStatus()).toEqual({
      reachable: true,
      modelAvailable: false,
      error: 'Chat model "llama3.2" is not installed in Ollama.',
      hint: 'Run "ollama pull llama3.2" on the Ollama host.',
    });
  });

  it('reports an unreachable provider without throwing', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await provider(fetchMock).checkStatus()).toMatchObject({
      reachable: false,
      modelAvailable: null,
      error: 'Ollama is not reachable.',
    });
  });

  it('reports an unexpected model list', async () => {
    expect(await provider(tags('nope')).checkStatus()).toMatchObject({
      reachable: true,
      modelAvailable: null,
    });
  });
});

describe('createChatProvider', () => {
  it('creates the Ollama adapter from the configuration', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => streamResponse([piece('x'), finalLine]));
    const chat = createChatProvider(
      testConfig({
        OLLAMA_BASE_URL: 'http://ollama.test:1234',
        CHAT_MODEL: 'llama3.2',
        CHAT_TIMEOUT_MS: '5000',
      }),
      { fetch: fetchMock },
    );

    expect(chat).toBeInstanceOf(OllamaChatProvider);
    expect(chat).toMatchObject({ id: 'ollama', model: 'llama3.2' });
    expect(await collect(chat.stream(messages))).toEqual(['x']);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://ollama.test:1234/api/chat');
  });
});
