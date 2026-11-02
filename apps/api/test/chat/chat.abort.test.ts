import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import {
  createInMemoryServices,
  createInMemoryStore,
  fakeDocument,
  healthyProbe,
} from '../fakes.js';
import { createFakeChatProvider } from '../fakes/fake-chat-provider.js';
import { fakeVector } from '../fakes/fake-embedding-provider.js';
import { testConfig } from '../helpers.js';

/** Abort needs a real socket: `inject()` cannot close the connection mid-response. */
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function startListening(chat: ReturnType<typeof createFakeChatProvider>) {
  const config = testConfig();
  const store = createInMemoryStore();
  const services = createInMemoryServices(config, store, { chatProvider: chat });
  app = await buildApp({ config, probe: healthyProbe, services, logger: false, sseHeartbeatMs: 0 });
  const collectionId = (await services.collections.create({ name: 'Docs' })).id;
  const document = fakeDocument({ collectionId });
  store.documents.set(document.id, document);
  const chunkId = crypto.randomUUID();
  store.chunks.set(document.id, [
    {
      id: chunkId,
      documentId: document.id,
      collectionId,
      chunkIndex: 0,
      content: 'text',
      startOffset: 0,
      endOffset: 4,
      charCount: 4,
      tokenEstimate: 1,
      headingPath: [],
      metadata: {},
      hasEmbedding: true,
      createdAt: new Date(),
    },
  ]);
  store.embeddings.set(chunkId, fakeVector('text', 768));
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/api/chat`, collectionId };
}

describe('POST /api/chat – client abort', () => {
  it('aborts the provider request when the client disconnects mid-stream', async () => {
    const chat = createFakeChatProvider({
      tokens: Array.from({ length: 200 }, (_, index) => `t${index} `),
      delayMs: 20,
    });
    const { url, collectionId } = await startListening(chat);
    const client = new AbortController();

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ collectionId, question: 'text' }),
      signal: client.signal,
    });
    expect(response.status).toBe(200);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    let received = '';
    while (!received.includes('event: token')) {
      const { value } = await reader.read();
      received += new TextDecoder().decode(value);
    }
    client.abort();

    const reason = await chat.aborted;
    expect((reason as Error).message).toBe('client closed the request');
    expect(chat.calls[0]?.signal?.aborted).toBe(true);
  });

  it('aborts open streams when the server shuts down', async () => {
    const chat = createFakeChatProvider({
      tokens: Array.from({ length: 200 }, (_, index) => `t${index} `),
      delayMs: 20,
    });
    const { url, collectionId } = await startListening(chat);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ collectionId, question: 'text' }),
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();

    await app?.close();
    app = undefined;

    expect(((await chat.aborted) as Error).message).toBe('server shutting down');
    await reader.cancel().catch(() => undefined);
  });
});
