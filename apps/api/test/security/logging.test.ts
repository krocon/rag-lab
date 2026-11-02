import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { loggerOptions, REDACTED } from '../../src/logging.js';
import { createFakeChatProvider } from '../fakes/fake-chat-provider.js';
import { testConfig } from '../helpers.js';
import { multipart } from '../multipart.js';
import { addReadyChunk, startApp } from './setup.js';

/** A pino logger with the production options that writes into `lines`. */
function recordingLogger(level: string, lines: string[]) {
  return pino(
    { ...loggerOptions(testConfig({ LOG_LEVEL: 'info' })), level },
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    }),
  );
}

const MARKERS = {
  document: 'DOCUMENT-CONTENT-MARKER-1c9e',
  chunk: 'CHUNK-CONTENT-MARKER-77ab',
  question: 'QUESTION-MARKER-5d02',
  query: 'QUERY-MARKER-a41f',
  answer: 'ANSWER-MARKER-e6b8',
  preview: 'PREVIEW-MARKER-0f3c',
  token: 'TOKEN-MARKER-93d1',
  cookie: 'COOKIE-MARKER-2b7a',
};

describe('logs', () => {
  it('contain no document content, queries, answers or credentials at info level', async () => {
    const lines: string[] = [];
    const { api, store, collectionId } = await startApp({
      chat: createFakeChatProvider({ tokens: [`${MARKERS.answer} `, '[1].'] }),
      loggerInstance: recordingLogger('info', lines),
    });
    addReadyChunk(store, collectionId, `Indexed text with ${MARKERS.chunk}.`);
    const credentials = {
      authorization: `Bearer ${MARKERS.token}`,
      cookie: `session=${MARKERS.cookie}`,
    };

    const { payload, headers } = multipart([
      { filename: 'notes.md', content: `# Notes\n\n${MARKERS.document}\n` },
    ]);
    const requests = [
      {
        method: 'POST' as const,
        url: `/api/collections/${collectionId}/documents`,
        payload,
        headers: { ...headers, ...credentials },
      },
      {
        method: 'POST' as const,
        url: '/api/chat',
        payload: { collectionId, question: `Why ${MARKERS.question}?` },
        headers: credentials,
      },
      {
        method: 'POST' as const,
        url: '/api/retrieval/search',
        payload: { collectionId, query: MARKERS.query },
        headers: credentials,
      },
      {
        method: 'POST' as const,
        url: '/api/playground/search',
        payload: { collectionId, query: MARKERS.query, includePrompt: true },
        headers: credentials,
      },
      {
        method: 'POST' as const,
        url: '/api/chunking/preview',
        payload: { text: MARKERS.preview, format: 'text' },
        headers: credentials,
      },
    ];
    for (const request of requests) {
      const response = await api.inject(request);
      expect(response.statusCode, request.url).toBeLessThan(300);
    }
    // The answer really contained the marker (so its absence in the log means something).
    const [, chatRequest] = requests;
    if (!chatRequest) {
      throw new Error('chat request missing');
    }
    const chat = await api.inject(chatRequest);
    expect(chat.body).toContain(MARKERS.answer);

    const output = lines.join('');
    expect(output).toContain('chat answer');
    expect(output).toContain('retrieval search');
    expect(output).toContain('documents uploaded');
    for (const [name, marker] of Object.entries(MARKERS)) {
      expect(output, `${name} leaked into the log`).not.toContain(marker);
    }
  });

  it('redact credential headers and configuration secrets in any log call', () => {
    const lines: string[] = [];
    const logger = recordingLogger('info', lines);

    logger.info(
      {
        req: { headers: { authorization: 'Bearer abc', cookie: 'a=b', 'x-api-key': 'k1' } },
        res: { headers: { 'set-cookie': 'session=1' } },
        headers: { authorization: 'Basic xyz', 'proxy-authorization': 'Basic p' },
        config: { database: { url: 'postgresql://u:DbPassword@db/raglab' } },
        databaseUrl: 'postgresql://u:DbPassword@db/raglab',
        provider: { apiKey: 'sk-secret', password: 'pw', token: 't0k' },
      },
      'diagnostics',
    );

    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(entry).toMatchObject({
      req: { headers: { authorization: REDACTED, cookie: REDACTED, 'x-api-key': REDACTED } },
      res: { headers: { 'set-cookie': REDACTED } },
      headers: { authorization: REDACTED, 'proxy-authorization': REDACTED },
      config: { database: { url: REDACTED } },
      databaseUrl: REDACTED,
      provider: { apiKey: REDACTED, password: REDACTED, token: REDACTED },
    });
    for (const secret of ['abc', 'DbPassword', 'sk-secret', 'Basic', 't0k']) {
      expect(lines[0]).not.toContain(secret);
    }
  });
});
