import { TestBed } from '@angular/core/testing';
import type { ChatStreamEvent } from '@raglab/shared';
import { COLLECTION_ID, chatDone, chatSource } from '../../../testing/fixtures';
import { FakeFetch, settle, sseFrame } from '../../../testing/fake-fetch';
import { ChatApi, FETCH } from './chat-api';

describe('ChatApi', () => {
  let fake: FakeFetch;
  let api: ChatApi;

  beforeEach(() => {
    fake = new FakeFetch();
    TestBed.configureTestingModule({ providers: [{ provide: FETCH, useValue: fake.fn }] });
    api = TestBed.inject(ChatApi);
  });

  async function collect(): Promise<{ events: ChatStreamEvent[]; error?: unknown }> {
    const events: ChatStreamEvent[] = [];
    try {
      for await (const event of api.streamChat({ collectionId: COLLECTION_ID, question: 'Why?' })) {
        events.push(event);
      }
      return { events };
    } catch (error) {
      return { events, error };
    }
  }

  it('posts the request to /api/chat and yields typed events in order', async () => {
    const promise = collect();
    await settle();
    expect(fake.requests[0]?.url).toBe('/api/chat');
    expect(fake.body()).toEqual({ collectionId: COLLECTION_ID, question: 'Why?' });

    const stream = fake.respondStream();
    stream.push(sseFrame('sources', { sources: [chatSource(1)] }));
    stream.push(': heartbeat\n\n');
    stream.push(sseFrame('token', { text: 'Because [1].' }));
    stream.push(sseFrame('done', chatDone()));
    stream.close();

    const { events, error } = await promise;
    expect(error).toBeUndefined();
    expect(events).toEqual([
      { event: 'sources', data: { sources: [chatSource(1)] } },
      { event: 'token', data: { text: 'Because [1].' } },
      { event: 'done', data: chatDone() },
    ]);
  });

  it('ignores unknown event names', async () => {
    const promise = collect();
    await settle();
    const stream = fake.respondStream();
    stream.push(sseFrame('progress', { step: 1 }));
    stream.push(sseFrame('error', { code: 'CHAT_PROVIDER_ERROR', message: 'Model missing' }));
    stream.close();

    expect((await promise).events).toEqual([
      { event: 'error', data: { code: 'CHAT_PROVIDER_ERROR', message: 'Model missing' } },
    ]);
  });

  it('rejects unreadable event data as INVALID_STREAM', async () => {
    const promise = collect();
    await settle();
    const stream = fake.respondStream();
    stream.push('event: token\ndata: {not json\n\n');
    stream.close();

    expect((await promise).error).toMatchObject({ status: 0, code: 'INVALID_STREAM' });
  });

  it('passes API errors before the stream through', async () => {
    const promise = collect();
    await settle();
    fake.respondJson(404, {
      error: { code: 'COLLECTION_NOT_FOUND', message: 'Collection not found' },
    });

    expect((await promise).error).toMatchObject({ status: 404, code: 'COLLECTION_NOT_FOUND' });
  });
});
