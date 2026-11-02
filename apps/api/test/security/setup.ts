import type { FastifyInstance } from 'fastify';
import { afterEach } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config/env.js';
import type { AppServices } from '../../src/services.js';
import {
  createInMemoryServices,
  createInMemoryStore,
  fakeDocument,
  healthyProbe,
  type InMemoryStore,
} from '../fakes.js';
import { createFakeChatProvider, type FakeChatProvider } from '../fakes/fake-chat-provider.js';
import { fakeVector } from '../fakes/fake-embedding-provider.js';
import { testConfig } from '../helpers.js';

let current: FastifyInstance | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

export interface SecurityApp {
  api: FastifyInstance;
  config: AppConfig;
  services: AppServices;
  store: InMemoryStore;
  chat: FakeChatProvider;
  collectionId: string;
}

/** App with in-memory services and one empty collection; closed after each test. */
export async function startApp({
  env = {},
  chat = createFakeChatProvider(),
  loggerInstance,
}: {
  env?: NodeJS.ProcessEnv;
  chat?: FakeChatProvider;
  loggerInstance?: Parameters<typeof buildApp>[0]['loggerInstance'];
} = {}): Promise<SecurityApp> {
  const config = testConfig(env);
  const store = createInMemoryStore();
  const services = createInMemoryServices(config, store, { chatProvider: chat });
  current = await buildApp({
    config,
    probe: healthyProbe,
    services,
    sseHeartbeatMs: 0,
    ...(loggerInstance ? { loggerInstance } : { logger: false }),
  });
  const collectionId = (await services.collections.create({ name: 'Docs' })).id;
  return { api: current, config, services, store, chat, collectionId };
}

export const UNKNOWN_ID = '0195f2a0-0000-7000-8000-000000000000';

/** Stores a `ready` document with one embedded chunk, so retrieval finds it and chat calls the model. */
export function addReadyChunk(store: InMemoryStore, collectionId: string, content: string): void {
  const document = fakeDocument({ collectionId });
  store.documents.set(document.id, document);
  const chunkId = crypto.randomUUID();
  store.chunks.set(document.id, [
    {
      id: chunkId,
      documentId: document.id,
      collectionId,
      chunkIndex: 0,
      content,
      startOffset: 0,
      endOffset: content.length,
      charCount: content.length,
      tokenEstimate: Math.ceil(content.length / 4),
      headingPath: [],
      metadata: {},
      hasEmbedding: true,
      createdAt: new Date(),
    },
  ]);
  store.embeddings.set(chunkId, fakeVector(content, 768));
}
