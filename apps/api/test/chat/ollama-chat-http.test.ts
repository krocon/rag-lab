import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OllamaChatProvider } from '../../src/modules/chat/ollama-chat-provider.js';

/**
 * The adapter with the real global `fetch` against a local fake Ollama server that streams
 * NDJSON like Ollama 0.40 (no model, no network access).
 */
let server: Server;
let baseUrl: string;
let lastRequestClosed: Promise<void> = Promise.resolve();

type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void;
let handler: Handler = (_request, response) => response.end();

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    lastRequestClosed = new Promise((resolve) => response.once('close', () => resolve()));
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => handler(request, response, body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const create = (model = 'fake-chat', timeoutMs = 2000) =>
  new OllamaChatProvider({ baseUrl, model, timeoutMs });

const piece = (content: string, done = false) =>
  `${JSON.stringify({ model: 'fake-chat', message: { role: 'assistant', content }, done })}\n`;

describe('OllamaChatProvider over HTTP', () => {
  it('streams NDJSON pieces written in several network chunks', async () => {
    let received: unknown;
    handler = (request, response, body) => {
      received = { url: request.url, body: JSON.parse(body) as unknown };
      response.setHeader('content-type', 'application/x-ndjson');
      const text = piece('Hello') + piece(' world') + piece('', true);
      // Split in the middle of a line.
      response.write(text.slice(0, 30));
      setTimeout(() => response.end(text.slice(30)), 10);
    };

    const pieces: string[] = [];
    for await (const text of create().stream([{ role: 'user', content: 'hi' }])) {
      pieces.push(text);
    }

    expect(pieces).toEqual(['Hello', ' world']);
    expect(received).toEqual({
      url: '/api/chat',
      body: { model: 'fake-chat', messages: [{ role: 'user', content: 'hi' }], stream: true },
    });
  });

  it('reports a missing model like Ollama 0.40 (404 + error text)', async () => {
    handler = (_request, response) => {
      response.statusCode = 404;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: "model 'missing' not found" }));
    };
    const stream = create('missing').stream([{ role: 'user', content: 'hi' }]);
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
    });
  });

  it('closes the upstream connection when the caller aborts mid-stream', async () => {
    handler = (_request, response) => {
      response.setHeader('content-type', 'application/x-ndjson');
      response.write(piece('first'));
      // Never finishes on its own.
    };
    const controller = new AbortController();
    const pieces: string[] = [];

    const error = await (async () => {
      for await (const text of create().stream(
        [{ role: 'user', content: 'hi' }],
        controller.signal,
      )) {
        pieces.push(text);
        controller.abort(new Error('client closed the request'));
      }
    })().catch((e: unknown) => e);

    expect(pieces).toEqual(['first']);
    expect((error as Error).message).toBe('client closed the request');
    await lastRequestClosed; // the fake Ollama saw the connection close
  });

  it('times out when the next line does not arrive in time', async () => {
    handler = (_request, response) => {
      response.setHeader('content-type', 'application/x-ndjson');
      response.write(piece('first'));
    };
    const pieces: string[] = [];
    const error = await (async () => {
      for await (const text of create('fake-chat', 100).stream([{ role: 'user', content: 'hi' }])) {
        pieces.push(text);
      }
    })().catch((e: unknown) => e);

    expect(pieces).toEqual(['first']);
    expect(error).toMatchObject({ code: 'PROVIDER_TIMEOUT' });
  });
});
