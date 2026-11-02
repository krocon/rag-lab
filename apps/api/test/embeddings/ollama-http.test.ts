import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OllamaEmbeddingProvider } from '../../src/modules/embeddings/ollama-embedding-provider.js';
import { fakeVector } from '../fakes/fake-embedding-provider.js';

/**
 * The adapter with the real global `fetch` against a local fake Ollama server (no model, no
 * network access). Responses mimic Ollama 0.40: `{ embeddings }`, `{ models }`, 404 + `{ error }`.
 */
let server: Server;
let baseUrl: string;
const received: { method: string; url: string; body: string }[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      received.push({ method: request.method ?? '', url: request.url ?? '', body });
      response.setHeader('content-type', 'application/json; charset=utf-8');
      if (request.url === '/api/tags') {
        response.end(
          JSON.stringify({ models: [{ name: 'fake-embed:latest', model: 'fake-embed:latest' }] }),
        );
        return;
      }
      const { model, input } = JSON.parse(body) as { model: string; input: string[] };
      if (model !== 'fake-embed') {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: `model '${model}' not found` }));
        return;
      }
      response.end(JSON.stringify({ model, embeddings: input.map((text) => fakeVector(text, 8)) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const create = (model: string, url = baseUrl) =>
  new OllamaEmbeddingProvider({
    baseUrl: url,
    model,
    dimensions: 8,
    batchSize: 2,
    timeoutMs: 2000,
  });

describe('OllamaEmbeddingProvider over HTTP', () => {
  it('embeds in batches via POST /api/embed', async () => {
    received.length = 0;

    const vectors = await create('fake-embed').embed(['a', 'b', 'c']);

    expect(vectors).toEqual(['a', 'b', 'c'].map((text) => fakeVector(text, 8)));
    expect(received.map((request) => [request.method, request.url])).toEqual([
      ['POST', '/api/embed'],
      ['POST', '/api/embed'],
    ]);
    expect(JSON.parse(received[0]?.body ?? '{}')).toEqual({
      model: 'fake-embed',
      input: ['a', 'b'],
    });
  });

  it('reports a missing model as MODEL_NOT_FOUND', async () => {
    await expect(create('missing').embed(['a'])).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
      details: { hint: 'Run "ollama pull missing" on the Ollama host.', status: 404 },
    });
  });

  it('checks the model list via GET /api/tags', async () => {
    expect(await create('fake-embed').checkStatus()).toEqual({
      reachable: true,
      modelAvailable: true,
    });
    expect((await create('missing').checkStatus()).modelAvailable).toBe(false);
  });

  it('reports a closed port as PROVIDER_UNREACHABLE', async () => {
    // Port 9 (discard) is practically never open on a developer machine or CI runner.
    const provider = create('fake-embed', 'http://127.0.0.1:9');

    await expect(provider.embed(['a'])).rejects.toMatchObject({ code: 'PROVIDER_UNREACHABLE' });
    expect(await provider.checkStatus()).toMatchObject({ reachable: false, modelAvailable: null });
  });
});
