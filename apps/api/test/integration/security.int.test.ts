import type { ChatSourcesEvent, CollectionDto, UploadDocumentsResponse } from '@raglab/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPgProbe } from '../../src/db/probe.js';
import { SYSTEM_PROMPT } from '../../src/modules/chat/prompt-builder.js';
import { neutralizeSourceTags } from '../../src/modules/chat/sanitize-source.js';
import { createServices, type AppServices } from '../../src/services.js';
import { createFakeChatProvider, type FakeChatProvider } from '../fakes/fake-chat-provider.js';
import { createFakeEmbeddingProvider } from '../fakes/fake-embedding-provider.js';
import { silentLogger, testConfig } from '../helpers.js';
import { multipart } from '../multipart.js';
import { INJECTION_DOCUMENT, sourceBlockBodies } from '../security/injection-helpers.js';
import { parseSse } from '../sse.js';
import { integrationDatabaseUrl, resetDatabase } from './setup.js';

/**
 * Prompt injection end to end: the prepared document goes through the real upload, chunking,
 * embedding (fake provider), pgvector retrieval and prompt builder; the fake chat provider
 * records the prompt the model would receive.
 */
const databaseUrl = integrationDatabaseUrl();
const connection = createDatabase(databaseUrl, 4);
const { pool } = connection;
// Small chunks: the document is split into several sources, each must stay delimited.
const config = testConfig({ DATABASE_URL: databaseUrl, CHUNK_SIZE: '300', CHUNK_OVERLAP: '0' });
const chat: FakeChatProvider = createFakeChatProvider({ tokens: ['Offline mode [1].'] });
let app: FastifyInstance;
let services: AppServices;

beforeAll(async () => {
  await runMigrations(databaseUrl);
  services = createServices(connection.db, config, silentLogger, {
    embeddingProvider: createFakeEmbeddingProvider({ dimensions: 768 }),
    chatProvider: chat,
  });
  app = await buildApp({
    config,
    probe: createPgProbe(pool, { embeddingDimensions: config.embedding.dimensions }),
    services,
    logger: false,
    sseHeartbeatMs: 0,
  });
});

beforeEach(async () => {
  await resetDatabase(pool);
  chat.calls.length = 0;
});

afterAll(async () => {
  await app.close();
  await resetDatabase(pool);
  await connection.close();
});

describe('prepared injection document (PostgreSQL)', () => {
  it('reaches the model only inside numbered source blocks with neutralised delimiters', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/collections',
      payload: { name: 'Release notes' },
    });
    const collectionId = created.json<CollectionDto>().id;
    const { payload, headers } = multipart([
      { filename: 'release-notes.md', content: INJECTION_DOCUMENT },
    ]);
    const uploaded = await app.inject({
      method: 'POST',
      url: `/api/collections/${collectionId}/documents`,
      payload,
      headers,
    });
    expect(uploaded.statusCode).toBe(202);
    const documentId = uploaded.json<UploadDocumentsResponse>().documents[0]?.id ?? '';
    await services.ingestion.indexer?.index(documentId);

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { collectionId, question: 'What changed in release 2.4?', topK: 50 },
    });

    expect(response.statusCode).toBe(200);
    const events = parseSse(response.body);
    const { sources } = events[0]?.data as ChatSourcesEvent;
    const stored = await pool.query<{ content: string }>(
      'SELECT content FROM chunks WHERE document_id = $1 ORDER BY chunk_index',
      [documentId],
    );
    expect(stored.rows.length).toBeGreaterThan(1);
    expect(sources).toHaveLength(stored.rows.length);

    expect(chat.calls).toHaveLength(1);
    const [system, user] = chat.calls[0]?.messages ?? [];
    expect(system).toEqual({ role: 'system', content: SYSTEM_PROMPT });
    expect(user?.role).toBe('user');
    const bodies = sourceBlockBodies(user?.content ?? '', sources.length);

    // Each block holds exactly one stored chunk (in rank order), neutralised – nothing else.
    const byContent = new Map(stored.rows.map((row) => [neutralizeSourceTags(row.content), row]));
    for (const body of bodies) {
      expect(byContent.has(body)).toBe(true);
    }
    expect(new Set(bodies).size).toBe(stored.rows.length);
    // The injected "Question:" is inside a block; the real question comes last.
    expect(user?.content.endsWith('\nQuestion:\nWhat changed in release 2.4?')).toBe(true);
    expect(bodies.join('\n')).toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
  });
});
