import { describe, expect, it } from 'vitest';
import {
  EmbeddingProviderError,
  type EmbeddingProviderErrorCode,
} from '../../src/modules/embeddings/embedding-provider.js';
import {
  OllamaEmbeddingProvider,
  type OllamaEmbeddingProviderOptions,
} from '../../src/modules/embeddings/ollama-embedding-provider.js';
import { fakeVector } from '../fakes/fake-embedding-provider.js';

interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
  signal: AbortSignal | undefined;
}

type Handler = (request: RecordedRequest) => Promise<Response> | Response;

/** `fetch` stand-in that records requests and answers with `handler`. */
function mockFetch(handler: Handler) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request: RecordedRequest = {
      url: input instanceof URL ? input.href : String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      signal: init?.signal ?? undefined,
    };
    requests.push(request);
    return handler(request);
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Answers `/api/embed` correctly with `dimensions`-long vectors. */
const embedHandler =
  (dimensions = 4): Handler =>
  ({ body }) => {
    const input = (body as { input: string[] }).input;
    return json({ model: 'm', embeddings: input.map((text) => fakeVector(text, dimensions)) });
  };

/** Never answers until the request is aborted (like a hanging server). */
const hangingHandler: Handler = ({ signal }) =>
  new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      reject(signal.reason as Error);
    });
  });

function provider(
  fetchImpl: typeof fetch,
  overrides: Partial<OllamaEmbeddingProviderOptions> = {},
): OllamaEmbeddingProvider {
  return new OllamaEmbeddingProvider({
    baseUrl: 'http://ollama.test:11434',
    model: 'nomic-embed-text',
    dimensions: 4,
    batchSize: 2,
    timeoutMs: 1000,
    fetch: fetchImpl,
    ...overrides,
  });
}

async function expectProviderError(
  promise: Promise<unknown>,
  code: EmbeddingProviderErrorCode,
): Promise<EmbeddingProviderError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(EmbeddingProviderError);
  expect((error as EmbeddingProviderError).code).toBe(code);
  return error as EmbeddingProviderError;
}

describe('OllamaEmbeddingProvider.embed', () => {
  it('posts { model, input } to /api/embed and returns the vectors in input order', async () => {
    const { fetch, requests } = mockFetch(embedHandler());
    const ollama = provider(fetch);

    const vectors = await ollama.embed(['a', 'b']);

    expect(ollama).toMatchObject({ id: 'ollama', model: 'nomic-embed-text', dimensions: 4 });
    expect(requests).toEqual([
      expect.objectContaining({
        url: 'http://ollama.test:11434/api/embed',
        method: 'POST',
        body: { model: 'nomic-embed-text', input: ['a', 'b'] },
      }),
    ]);
    expect(vectors).toEqual([fakeVector('a', 4), fakeVector('b', 4)]);
  });

  it.each([
    [0, []],
    [1, [['t0']]],
    [2, [['t0', 't1']]],
    [3, [['t0', 't1'], ['t2']]],
    [5, [['t0', 't1'], ['t2', 't3'], ['t4']]],
  ])('splits %i texts into batches of at most 2', async (count, expectedBatches) => {
    const { fetch, requests } = mockFetch(embedHandler());
    const texts = Array.from({ length: count }, (_, index) => `t${index}`);

    const vectors = await provider(fetch).embed(texts);

    expect(requests.map((request) => (request.body as { input: string[] }).input)).toEqual(
      expectedBatches,
    );
    expect(vectors).toEqual(texts.map((text) => fakeVector(text, 4)));
  });

  it('keeps a path prefix of the base URL', async () => {
    const { fetch, requests } = mockFetch(embedHandler());

    await provider(fetch, { baseUrl: 'http://proxy.test/ollama/' }).embed(['a']);

    expect(requests[0]?.url).toBe('http://proxy.test/ollama/api/embed');
  });

  it('maps HTTP 404 to MODEL_NOT_FOUND with an "ollama pull" hint', async () => {
    // Body as returned by Ollama 0.40 for a missing model.
    const { fetch } = mockFetch(() => json({ error: "model 'nomic-embed-text' not found" }, 404));

    const error = await expectProviderError(provider(fetch).embed(['a']), 'MODEL_NOT_FOUND');

    expect(error.message).toBe('Embedding model "nomic-embed-text" is not installed in Ollama.');
    expect(error.details.hint).toBe('Run "ollama pull nomic-embed-text" on the Ollama host.');
    expect(error.userMessage).toContain('ollama pull nomic-embed-text');
  });

  it('recognises "model not found" in other error statuses', async () => {
    const { fetch } = mockFetch(() => json({ error: 'model "x" not found, try pulling it' }, 500));

    await expectProviderError(provider(fetch).embed(['a']), 'MODEL_NOT_FOUND');
  });

  it('maps other HTTP errors to PROVIDER_ERROR with a shortened provider message', async () => {
    const { fetch } = mockFetch(() =>
      json({ error: `this model does not support embeddings ${'x'.repeat(500)}` }, 500),
    );

    const error = await expectProviderError(provider(fetch).embed(['a']), 'PROVIDER_ERROR');

    expect(error.message).toMatch(/^Ollama answered with HTTP 500: this model does not support/);
    expect(error.message.length).toBeLessThan(260);
    expect(error.details.status).toBe(500);
  });

  it('maps network errors to PROVIDER_UNREACHABLE', async () => {
    const { fetch } = mockFetch(() => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
    });

    const error = await expectProviderError(provider(fetch).embed(['a']), 'PROVIDER_UNREACHABLE');

    expect(error.message).toBe('Ollama is not reachable.');
    expect(error.details.hint).toContain('OLLAMA_BASE_URL');
  });

  it('maps a hanging request to PROVIDER_TIMEOUT after timeoutMs', async () => {
    const { fetch } = mockFetch(hangingHandler);
    const started = Date.now();

    const error = await expectProviderError(
      provider(fetch, { timeoutMs: 30 }).embed(['a']),
      'PROVIDER_TIMEOUT',
    );

    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(error.message).toBe('Ollama did not answer within 30 ms.');
    expect(error.details.hint).toContain('EMBEDDING_TIMEOUT_MS');
  });

  it('rejects with the abort reason (not a provider error) when the caller aborts', async () => {
    const { fetch } = mockFetch(hangingHandler);
    const controller = new AbortController();
    const reason = new Error('shutdown');

    const promise = provider(fetch, { timeoutMs: 10_000 }).embed(['a'], controller.signal);
    setTimeout(() => {
      controller.abort(reason);
    }, 5);

    await expect(promise).rejects.toBe(reason);
  });

  it('does not send a request when the signal is already aborted', async () => {
    const { fetch, requests } = mockFetch(embedHandler());
    const controller = new AbortController();
    controller.abort(new Error('stop'));

    await expect(provider(fetch).embed(['a'], controller.signal)).rejects.toThrow('stop');
    expect(requests).toHaveLength(0);
  });

  it('stops between batches once aborted', async () => {
    const controller = new AbortController();
    const { fetch, requests } = mockFetch((request) => {
      controller.abort(new Error('stop'));
      return embedHandler()(request);
    });

    await expect(provider(fetch).embed(['a', 'b', 'c'], controller.signal)).rejects.toThrow('stop');
    expect(requests).toHaveLength(1);
  });

  it('rejects vectors of the wrong length with DIMENSION_MISMATCH (no truncation or padding)', async () => {
    const { fetch } = mockFetch(embedHandler(3));

    const error = await expectProviderError(provider(fetch).embed(['a']), 'DIMENSION_MISMATCH');

    expect(error.details).toMatchObject({ expected: 4, actual: 3 });
    expect(error.message).toContain('3 dimensions, but EMBEDDING_DIMENSIONS is 4');
  });

  it('rejects longer vectors as well', async () => {
    const { fetch } = mockFetch(embedHandler(5));

    await expectProviderError(provider(fetch).embed(['a']), 'DIMENSION_MISMATCH');
  });

  it.each([
    ['fewer vectors than texts', { embeddings: [[0, 0, 0, 1]] }],
    [
      'more vectors than texts',
      {
        embeddings: [
          [0, 0, 0, 1],
          [0, 0, 1, 0],
          [0, 1, 0, 0],
        ],
      },
    ],
    ['no embeddings field', { model: 'm' }],
    ['a non-array vector', { embeddings: ['x', 'y'] }],
    [
      'non-numeric values',
      {
        embeddings: [
          [0, 0, 0, 'x'],
          [0, 0, 0, 1],
        ],
      },
    ],
  ])('rejects a response with %s as PROVIDER_ERROR', async (_label, body) => {
    const { fetch } = mockFetch(() => json(body));

    await expectProviderError(provider(fetch).embed(['a', 'b']), 'PROVIDER_ERROR');
  });

  it('rejects a response that is not JSON', async () => {
    const { fetch } = mockFetch(() => new Response('<html>proxy error</html>', { status: 200 }));

    await expectProviderError(provider(fetch).embed(['a']), 'PROVIDER_ERROR');
  });

  it('never puts the embedded texts into error messages', async () => {
    const secret = 'confidential document text';
    const { fetch } = mockFetch(() => json({ embeddings: [] }));

    const error = await expectProviderError(provider(fetch).embed([secret]), 'PROVIDER_ERROR');

    expect(error.userMessage).not.toContain(secret);
  });

  it('requires a positive batch size', () => {
    const { fetch } = mockFetch(embedHandler());
    expect(() => provider(fetch, { batchSize: 0 })).toThrow(/batch size/);
  });
});

describe('OllamaEmbeddingProvider.checkStatus', () => {
  const tags = (...names: string[]) =>
    json({ models: names.map((name) => ({ name, model: name, size: 1 })) });

  it('reports a reachable provider with the model installed (GET /api/tags)', async () => {
    const { fetch, requests } = mockFetch(() => tags('llama3.2:latest', 'nomic-embed-text:latest'));

    const status = await provider(fetch).checkStatus();

    expect(status).toEqual({ reachable: true, modelAvailable: true });
    expect(requests[0]).toMatchObject({ url: 'http://ollama.test:11434/api/tags', method: 'GET' });
  });

  it('matches an explicitly tagged model exactly', async () => {
    const { fetch } = mockFetch(() => tags('nomic-embed-text:latest'));

    expect(
      (await provider(fetch, { model: 'nomic-embed-text:v1.5' }).checkStatus()).modelAvailable,
    ).toBe(false);
    expect(
      (await provider(fetch, { model: 'nomic-embed-text:latest' }).checkStatus()).modelAvailable,
    ).toBe(true);
  });

  it('reports a missing model with a pull hint', async () => {
    // Ollama 0.40 without any model answers { "models": [] }.
    const { fetch } = mockFetch(() => tags());

    expect(await provider(fetch).checkStatus()).toEqual({
      reachable: true,
      modelAvailable: false,
      error: 'Embedding model "nomic-embed-text" is not installed in Ollama.',
      hint: 'Run "ollama pull nomic-embed-text" on the Ollama host.',
    });
  });

  it('reports an unreachable provider without throwing', async () => {
    const { fetch } = mockFetch(() => {
      throw new TypeError('fetch failed');
    });

    expect(await provider(fetch).checkStatus()).toMatchObject({
      reachable: false,
      modelAvailable: null,
      error: 'Ollama is not reachable.',
    });
  });

  it('reports a timeout as unreachable', async () => {
    const { fetch } = mockFetch(hangingHandler);

    expect(await provider(fetch, { timeoutMs: 20 }).checkStatus()).toMatchObject({
      reachable: false,
      modelAvailable: null,
      error: 'Ollama did not answer within 20 ms.',
    });
  });

  it('reports an unexpected model list as unknown availability', async () => {
    const { fetch } = mockFetch(() => json({ something: 'else' }));

    expect(await provider(fetch).checkStatus()).toMatchObject({
      reachable: true,
      modelAvailable: null,
    });
  });
});
