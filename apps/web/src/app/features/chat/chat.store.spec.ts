import { TestBed } from '@angular/core/testing';
import { COLLECTION_ID, apiError, chatDone, chatSource } from '../../../testing/fixtures';
import { FakeFetch, settle, sseFrame } from '../../../testing/fake-fetch';
import { FETCH } from '../../core/api/chat-api';
import { ChatStore, INCOMPLETE_STREAM_MESSAGE, type ChatTurn } from './chat.store';

const COLLECTION = { id: COLLECTION_ID, name: 'Project docs' };

describe('ChatStore', () => {
  let fake: FakeFetch;
  let store: ChatStore;

  beforeEach(() => {
    fake = new FakeFetch();
    TestBed.configureTestingModule({ providers: [{ provide: FETCH, useValue: fake.fn }] });
    store = TestBed.inject(ChatStore);
  });

  async function ask(question = 'How do I reindex?'): Promise<ChatTurn> {
    const turn = store.send(COLLECTION, question);
    if (!turn) {
      throw new Error('send was ignored');
    }
    await settle();
    return turn;
  }

  it('moves through retrieving → streaming → done with sources before tokens', async () => {
    const turn = await ask('  How do I reindex?  ');
    expect(turn.question).toBe('How do I reindex?');
    expect(fake.body()).toEqual({ collectionId: COLLECTION_ID, question: 'How do I reindex?' });
    expect(turn.status()).toBe('retrieving');
    expect(store.busy()).toBe(true);
    expect(store.announcement()).toContain('Searching sources');

    const stream = fake.respondStream();
    stream.push(sseFrame('sources', { sources: [chatSource(1), chatSource(2)] }));
    await settle();
    expect(turn.status()).toBe('streaming');
    expect(turn.sources()).toHaveLength(2);
    expect(turn.answer()).toBe('');
    expect(store.announcement()).toBe('2 sources found. Generating answer…');

    stream.push(sseFrame('token', { text: 'Use reindex ' }));
    stream.push(sseFrame('token', { text: '[1].' }));
    await settle();
    expect(turn.answer()).toBe('Use reindex [1].');
    // Tokens are not announced one by one.
    expect(store.announcement()).toBe('2 sources found. Generating answer…');

    stream.push(sseFrame('done', chatDone()));
    await settle();
    expect(turn.status()).toBe('done');
    expect(turn.done()).toEqual(chatDone());
    expect(store.busy()).toBe(false);
    expect(store.announcement()).toBe('Answer complete. Cites source 1.');
    expect(stream.cancelled).toBe(true);
  });

  it('marks a no_sources answer', async () => {
    const turn = await ask();
    const stream = fake.respondStream();
    stream.push(sseFrame('sources', { sources: [] }));
    stream.push(sseFrame('token', { text: 'No matching sources were found.' }));
    stream.push(
      sseFrame('done', chatDone({ answerStatus: 'no_sources', citedSources: [], model: null })),
    );
    await settle();

    expect(turn.status()).toBe('done');
    expect(turn.noSources()).toBe(true);
    expect(store.announcement()).toContain('No matching sources');
  });

  it('ignores blank questions and a second question while one is streaming', async () => {
    expect(store.send(COLLECTION, '   ')).toBeUndefined();
    await ask();
    expect(store.send(COLLECTION, 'Another')).toBeUndefined();
    expect(store.turns()).toHaveLength(1);
    expect(fake.requests).toHaveLength(1);
  });

  it('cancel aborts the request at once and keeps the partial answer', async () => {
    const turn = await ask();
    const stream = fake.respondStream();
    stream.push(sseFrame('sources', { sources: [chatSource(1)] }));
    stream.push(sseFrame('token', { text: 'Partial' }));
    await settle();

    store.cancel();
    expect(turn.status()).toBe('aborted');
    expect(store.busy()).toBe(false);
    expect(fake.requests[0]?.init.signal?.aborted).toBe(true);
    expect(store.announcement()).toBe('Answer cancelled.');

    // Nothing arriving later changes the cancelled turn.
    stream.push(sseFrame('token', { text: ' more' }));
    await settle();
    expect(turn.answer()).toBe('Partial');
    expect(turn.status()).toBe('aborted');
    expect(turn.error()).toBeNull();
  });

  it('cancel works before the response arrived', async () => {
    const turn = await ask();
    store.cancel();
    await settle();
    expect(turn.status()).toBe('aborted');
    expect(turn.error()).toBeNull();
  });

  it.each([
    [400, 'VALIDATION_ERROR', 'question must not be blank'],
    [404, 'COLLECTION_NOT_FOUND', 'Collection not found'],
    [409, 'EMBEDDING_MODEL_MISMATCH', 'Embedding model differs'],
    [503, 'EMBEDDING_PROVIDER_UNAVAILABLE', 'Ollama is not reachable'],
  ])('maps %i %s before the stream to a request error', async (status, code, message) => {
    const turn = await ask();
    fake.respondJson(status, apiError(code, message));
    await settle();

    expect(turn.status()).toBe('error');
    expect(turn.error()).toEqual({ kind: 'request', status, code, message });
    expect(store.busy()).toBe(false);
  });

  it('maps an error event to a stream error and keeps the text so far', async () => {
    const turn = await ask();
    const stream = fake.respondStream();
    stream.push(sseFrame('sources', { sources: [chatSource(1)] }));
    stream.push(sseFrame('token', { text: 'Half' }));
    stream.push(sseFrame('error', { code: 'CHAT_PROVIDER_ERROR', message: 'Model not found' }));
    await settle();

    expect(turn.status()).toBe('error');
    expect(turn.answer()).toBe('Half');
    expect(turn.error()).toEqual({
      kind: 'stream',
      status: 0,
      code: 'CHAT_PROVIDER_ERROR',
      message: 'Model not found',
    });
  });

  it('maps an unreachable API to a network error', async () => {
    const turn = await ask();
    fake.failNetwork();
    await settle();

    expect(turn.error()).toMatchObject({ kind: 'network', code: 'NETWORK_ERROR' });
  });

  it('maps a proxy 502 without API body to a network error', async () => {
    const turn = await ask();
    fake.requests[0]?.resolve(new Response('', { status: 502 }));
    await settle();

    expect(turn.error()).toMatchObject({ kind: 'network', code: 'NETWORK_ERROR', status: 502 });
  });

  it('maps a broken connection to an interrupted error', async () => {
    const turn = await ask();
    const stream = fake.respondStream();
    stream.push(sseFrame('sources', { sources: [chatSource(1)] }));
    await settle();
    stream.fail();
    await settle();

    expect(turn.error()).toMatchObject({ kind: 'interrupted', code: 'STREAM_INTERRUPTED' });
  });

  it('treats a stream that ends without done/error as interrupted', async () => {
    const turn = await ask();
    const stream = fake.respondStream();
    stream.push(sseFrame('sources', { sources: [chatSource(1)] }));
    stream.push(sseFrame('token', { text: 'Half' }));
    stream.close();
    await settle();

    expect(turn.error()).toEqual({
      kind: 'interrupted',
      code: 'STREAM_INTERRUPTED',
      message: INCOMPLETE_STREAM_MESSAGE,
      status: 0,
    });
  });

  it('retry asks the same question again in place', async () => {
    const turn = await ask();
    fake.failNetwork();
    await settle();

    store.retry(turn);
    await settle();
    expect(turn.status()).toBe('retrieving');
    expect(turn.error()).toBeNull();
    expect(fake.requests).toHaveLength(2);
    expect(fake.body(1)).toEqual({ collectionId: COLLECTION_ID, question: 'How do I reindex?' });

    const stream = fake.respondStream();
    stream.push(sseFrame('sources', { sources: [] }));
    stream.push(sseFrame('done', chatDone({ answerStatus: 'no_sources', citedSources: [] })));
    await settle();
    expect(turn.status()).toBe('done');
    expect(store.turns()).toEqual([turn]);
  });

  it('clear cancels a running answer and empties the conversation', async () => {
    await ask();
    store.clear();

    expect(store.turns()).toEqual([]);
    expect(store.busy()).toBe(false);
    expect(fake.requests[0]?.init.signal?.aborted).toBe(true);
    expect(store.announcement()).toBe('Started a new chat.');
  });

  it('re-announces a repeated message', () => {
    store.clear();
    const first = store.announcement();
    store.clear();

    expect(store.announcement()).not.toBe(first);
    expect(store.announcement().trim()).toBe(first);
  });
});
