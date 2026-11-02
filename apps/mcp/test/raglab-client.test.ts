import { describe, expect, it } from 'vitest';
import { RaglabApiError } from '../src/errors.js';
import { createRaglabClient, type FetchFn } from '../src/raglab-client.js';
import { collection, COLLECTION_ID, DOCUMENT_ID, searchResponse } from './fakes.js';

interface Recorded {
  url: string;
  init: RequestInit;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sse(...chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
  );
}

function setup(respond: (request: Recorded) => Response | Promise<Response>, timeouts = {}) {
  const requests: Recorded[] = [];
  const fetch: FetchFn = async (url, init) => {
    const request = { url, init };
    requests.push(request);
    return respond(request);
  };
  const client = createRaglabClient({
    apiUrl: 'http://127.0.0.1:3000',
    requestTimeoutMs: 1000,
    chatTimeoutMs: 1000,
    fetch,
    userAgent: 'raglab-mcp/test',
    ...timeouts,
  });
  return { client, requests };
}

async function rejection(promise: Promise<unknown>): Promise<RaglabApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RaglabApiError);
    return error as RaglabApiError;
  }
  throw new Error('expected a rejection');
}

describe('RaglabClient (JSON endpoints)', () => {
  it('lists collections with GET and plain server-to-server headers (no Origin)', async () => {
    const { client, requests } = setup(() => json(200, { items: [collection()] }));
    await expect(client.listCollections()).resolves.toEqual([collection()]);
    expect(requests[0]?.url).toBe('http://127.0.0.1:3000/api/collections');
    expect(requests[0]?.init.method).toBe('GET');
    expect(requests[0]?.init.redirect).toBe('error');
    const headers = requests[0]?.init.headers as Record<string, string>;
    expect(headers).toEqual({ accept: 'application/json', 'user-agent': 'raglab-mcp/test' });
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain('origin');
  });

  it('posts searches as JSON', async () => {
    const { client, requests } = setup(() => json(200, searchResponse()));
    await expect(
      client.search({ collectionId: COLLECTION_ID, query: 'q', topK: 3 }),
    ).resolves.toEqual(searchResponse());
    expect(requests[0]?.url).toBe('http://127.0.0.1:3000/api/retrieval/search');
    expect(requests[0]?.init.method).toBe('POST');
    expect(JSON.parse(requests[0]?.init.body as string)).toEqual({
      collectionId: COLLECTION_ID,
      query: 'q',
      topK: 3,
    });
    expect((requests[0]?.init.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    );
  });

  it('builds document URLs with encoded IDs', async () => {
    const { client, requests } = setup(() => json(200, {}));
    await client.getDocument(DOCUMENT_ID);
    await client.getDocumentContent(DOCUMENT_ID);
    await client.getDocumentChunks('../x');
    expect(requests.map((request) => request.url)).toEqual([
      `http://127.0.0.1:3000/api/documents/${DOCUMENT_ID}`,
      `http://127.0.0.1:3000/api/documents/${DOCUMENT_ID}/content`,
      'http://127.0.0.1:3000/api/documents/..%2Fx/chunks',
    ]);
  });

  it('keeps a base path of the API URL', async () => {
    const requests: string[] = [];
    const client = createRaglabClient({
      apiUrl: 'https://proxy.example.com/raglab',
      requestTimeoutMs: 1000,
      chatTimeoutMs: 1000,
      fetch: async (url) => {
        requests.push(url);
        return json(200, { items: [] });
      },
    });
    await client.listCollections();
    expect(requests).toEqual(['https://proxy.example.com/raglab/api/collections']);
  });

  it('takes code, message and details from API error responses', async () => {
    const { client } = setup(() =>
      json(404, { error: { code: 'DOCUMENT_NOT_FOUND', message: 'Document not found.' } }),
    );
    const error = await rejection(client.getDocument(DOCUMENT_ID));
    expect(error).toMatchObject({ status: 404, code: 'DOCUMENT_NOT_FOUND' });
    expect(error.message).toBe('Document not found.');

    const limited = setup(() =>
      json(429, {
        error: { code: 'RATE_LIMITED', message: 'Too many.', details: { retryAfterSeconds: 3 } },
      }),
    );
    expect(await rejection(limited.client.listCollections())).toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: 3 },
    });
  });

  it('reports responses without the error format and invalid JSON', async () => {
    const { client } = setup(() => new Response('<html>bad gateway</html>', { status: 502 }));
    expect(await rejection(client.listCollections())).toMatchObject({
      status: 502,
      code: 'UNEXPECTED_RESPONSE',
    });
    const invalid = setup(() => new Response('not json', { status: 200 }));
    expect(await rejection(invalid.client.listCollections())).toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
    });
  });

  it('reports an unreachable API without internals', async () => {
    const { client } = setup(() => {
      throw new TypeError('fetch failed');
    });
    const error = await rejection(client.listCollections());
    expect(error).toMatchObject({ status: 0, code: 'API_UNREACHABLE' });
    expect(error.message).toContain('http://127.0.0.1:3000');
    expect(error.message).toContain('RAGLAB_API_URL');
  });

  it('times out hanging requests', async () => {
    const { client } = setup(
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
      { requestTimeoutMs: 20 },
    );
    expect(await rejection(client.listCollections())).toMatchObject({ code: 'API_TIMEOUT' });
  });

  it('rethrows cancellation by the caller unchanged', async () => {
    const { client } = setup(
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const controller = new AbortController();
    const pending = client.listCollections(controller.signal);
    controller.abort(new Error('cancelled by client'));
    await expect(pending).rejects.toThrow('cancelled by client');
  });
});

describe('RaglabClient.chat (SSE)', () => {
  const sources = [{ n: 1, documentId: DOCUMENT_ID, content: 'x' }];
  const done = {
    answerStatus: 'answered',
    citedSources: [1],
    unknownCitations: [],
    model: 'llama3.2',
    timings: { embeddingMs: 1, searchMs: 1, firstTokenMs: 1, generationMs: 1, totalMs: 3 },
  };

  it('collects sources, tokens and done from the stream', async () => {
    const { client, requests } = setup(() =>
      sse(
        `event: sources\ndata: ${JSON.stringify({ sources })}\n\n: heartbeat\n\n`,
        'event: token\ndata: {"text":"Hello "}\n\nevent: tok',
        'en\ndata: {"text":"[1]"}\n\n',
        `event: done\ndata: ${JSON.stringify(done)}\n\n`,
      ),
    );
    const result = await client.chat({ collectionId: COLLECTION_ID, question: 'q?' });
    expect(result).toEqual({ sources, answer: 'Hello [1]', done, error: null });
    expect(requests[0]?.url).toBe('http://127.0.0.1:3000/api/chat');
    expect((requests[0]?.init.headers as Record<string, string>).accept).toBe('text/event-stream');
  });

  it('returns the error event of the stream', async () => {
    const { client } = setup(() =>
      sse(
        'event: sources\ndata: {"sources":[]}\n\n',
        'event: error\ndata: {"code":"CHAT_PROVIDER_ERROR","message":"Model missing."}\n\n',
      ),
    );
    const result = await client.chat({ collectionId: COLLECTION_ID, question: 'q?' });
    expect(result.done).toBeNull();
    expect(result.error).toEqual({ code: 'CHAT_PROVIDER_ERROR', message: 'Model missing.' });
  });

  it('reports JSON errors before the stream (e.g. unknown collection)', async () => {
    const { client } = setup(() =>
      json(404, { error: { code: 'COLLECTION_NOT_FOUND', message: 'Collection not found.' } }),
    );
    expect(
      await rejection(client.chat({ collectionId: COLLECTION_ID, question: 'q?' })),
    ).toMatchObject({ status: 404, code: 'COLLECTION_NOT_FOUND' });
  });

  it('reports a stream that ends without done/error', async () => {
    const { client } = setup(() => sse('event: sources\ndata: {"sources":[]}\n\n'));
    expect(
      await rejection(client.chat({ collectionId: COLLECTION_ID, question: 'q?' })),
    ).toMatchObject({ code: 'STREAM_INTERRUPTED' });
  });

  it('rejects non-SSE success responses and invalid event data', async () => {
    const { client } = setup(() => json(200, { ok: true }));
    expect(
      await rejection(client.chat({ collectionId: COLLECTION_ID, question: 'q?' })),
    ).toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
    const broken = setup(() => sse('event: token\ndata: {not json\n\n'));
    expect(
      await rejection(broken.client.chat({ collectionId: COLLECTION_ID, question: 'q?' })),
    ).toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });
});
