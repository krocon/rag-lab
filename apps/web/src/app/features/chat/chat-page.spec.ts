import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import type { CollectionDto } from '@raglab/shared';
import {
  COLLECTION_ID,
  DOCUMENT_ID,
  apiError,
  chatDone,
  chatSource,
  collection,
  required,
  text,
} from '../../../testing/fixtures';
import { FakeFetch, type FakeStream, settle, sseFrame } from '../../../testing/fake-fetch';
import { FETCH } from '../../core/api/chat-api';
import { ChatPage } from './chat-page';

const OTHER_ID = '0190a8c4-0000-7000-8000-000000000009';
const EMPTY_ID = '0190a8c4-0000-7000-8000-000000000008';

describe('ChatPage', () => {
  let fixture: ComponentFixture<ChatPage>;
  let http: HttpTestingController;
  let fake: FakeFetch;
  let element: HTMLElement;

  beforeEach(() => {
    fake = new FakeFetch();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([], withComponentInputBinding()),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: FETCH, useValue: fake.fn },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    fixture.destroy();
    element.remove();
    http.verify();
  });

  const defaultCollections = (): CollectionDto[] => [
    collection(),
    collection({ id: OTHER_ID, name: 'Second', readyDocumentCount: 2 }),
    collection({ id: EMPTY_ID, name: 'Still indexing', readyDocumentCount: 0 }),
  ];

  async function render(): Promise<void> {
    await settle();
    TestBed.tick();
  }

  async function open(
    collections: CollectionDto[] = defaultCollections(),
    param?: string,
  ): Promise<void> {
    fixture = TestBed.createComponent(ChatPage);
    if (param !== undefined) {
      fixture.componentRef.setInput('collection', param);
    }
    element = fixture.nativeElement as HTMLElement;
    document.body.appendChild(element);
    TestBed.tick();
    http.expectOne('/api/collections').flush({ items: collections });
    await render();
  }

  const textarea = () => required(element.querySelector('textarea'), 'question field');
  const select = () => required(element.querySelector('select'), 'collection select');
  const button = (name: string) =>
    Array.from(element.querySelectorAll('button')).find((b) => text(b).includes(name));
  const sendButton = () => required(button('Send'), 'Send button');
  const liveRegion = () => text(element.querySelector('[role="status"][aria-live="polite"]'));

  function type(value: string): void {
    textarea().value = value;
    textarea().dispatchEvent(new Event('input'));
    TestBed.tick();
  }

  function press(key: string, options: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...options,
    });
    textarea().dispatchEvent(event);
    TestBed.tick();
    return event;
  }

  async function ask(question = 'How do I reindex?'): Promise<FakeStream> {
    type(question);
    press('Enter');
    await render();
    const stream = fake.respondStream();
    await render();
    return stream;
  }

  async function push(stream: FakeStream, ...frames: string[]): Promise<void> {
    for (const frame of frames) {
      stream.push(frame);
    }
    await render();
  }

  it('shows the instructions, the prompt-injection notice and askable knowledge bases', async () => {
    await open();

    expect(text(element.querySelector('h1'))).toBe('Chat');
    expect(text(element.querySelector('[role="note"]'))).toContain(
      'A manipulated document can steer the answer – always check the cited sources.',
    );
    expect(text(element)).toContain('How it works');

    const options = Array.from(select().options);
    expect(options.map((o) => [text(o), o.disabled])).toEqual([
      ['Project docs', false],
      ['Second', false],
      ['Still indexing (no ready documents)', true],
    ]);
    expect(select().value).toBe(COLLECTION_ID);
    expect(text(element)).toContain('Only knowledge bases with at least one ready document');
    // Keyboard help is visible.
    expect(text(element.querySelector('#chat-question-hint'))).toContain(
      'Enter sends · Shift+Enter adds a line · Esc cancels a running answer',
    );
  });

  it('preselects ?collection= and warns about a link to an unusable knowledge base', async () => {
    await open(defaultCollections(), OTHER_ID);
    expect(select().value).toBe(OTHER_ID);
    fixture.destroy();
    element.remove();

    await open(defaultCollections(), EMPTY_ID);
    expect(text(element.querySelector('.rl-alert--warn'))).toContain(
      '“Still indexing” has no ready documents yet',
    );
    type('Question');
    expect(sendButton().disabled).toBe(true);
    expect(text(element.querySelector('#chat-question-hint'))).toBe(
      'Choose a knowledge base first.',
    );
  });

  it('pre-fills ?q= (e.g. from the playground) without sending it', async () => {
    fixture = TestBed.createComponent(ChatPage);
    fixture.componentRef.setInput('collection', OTHER_ID);
    fixture.componentRef.setInput('q', '  How do I reindex?  ');
    element = fixture.nativeElement as HTMLElement;
    document.body.appendChild(element);
    TestBed.tick();
    http.expectOne('/api/collections').flush({ items: defaultCollections() });
    await render();

    expect(select().value).toBe(OTHER_ID);
    expect(textarea().value).toBe('How do I reindex?');
    expect(sendButton().disabled).toBe(false);
    expect(fake.requests).toHaveLength(0);
  });

  it('explains what to do when no knowledge base can be asked', async () => {
    await open([]);
    expect(text(element)).toContain('There is no knowledge base yet.');
    type('Question');
    expect(sendButton().disabled).toBe(true);
    expect(textarea().getAttribute('aria-disabled')).toBe('true');
  });

  it('shows an error with retry when the knowledge bases cannot be loaded', async () => {
    fixture = TestBed.createComponent(ChatPage);
    element = fixture.nativeElement as HTMLElement;
    TestBed.tick();
    http
      .expectOne('/api/collections')
      .flush(apiError('INTERNAL_ERROR', 'Boom'), { status: 500, statusText: 'Error' });
    await render();

    expect(text(element.querySelector('[role="alert"]'))).toContain(
      'The knowledge bases could not be loaded. Boom',
    );
    button('Try again')?.click();
    TestBed.tick();
    http.expectOne('/api/collections').flush({ items: defaultCollections() });
    await render();
    expect(element.querySelector('select')).not.toBeNull();
  });

  it('streams an answer: sources first, then tokens, then done', async () => {
    await open();
    select().value = OTHER_ID;
    select().dispatchEvent(new Event('change'));
    TestBed.tick();

    type('How do I reindex?');
    press('Enter');
    await render();
    expect(fake.body()).toEqual({ collectionId: OTHER_ID, question: 'How do I reindex?' });
    expect(textarea().value).toBe('');
    expect(document.activeElement).toBe(textarea());
    expect(text(element.querySelector('.question'))).toBe('How do I reindex?');
    expect(text(element)).toContain('Searching sources…');
    expect(liveRegion()).toContain('Searching sources');

    const stream = fake.respondStream();
    await push(stream, sseFrame('sources', { sources: [chatSource(1), chatSource(2)] }));
    expect(element.querySelectorAll('[data-source]')).toHaveLength(2);
    expect(text(element)).toContain('Generating…');
    expect(liveRegion()).toBe('2 sources found. Generating answer…');
    expect(button('Cancel answer')).toBeDefined();

    await push(stream, sseFrame('token', { text: 'Use reindex ' }));
    expect(text(element.querySelector('[data-testid="answer"]'))).toBe('Use reindex');
    await push(stream, sseFrame('token', { text: '[1].\nThen wait.' }));
    // Tokens are not announced.
    expect(liveRegion()).toBe('2 sources found. Generating answer…');
    expect(element.querySelector('section.answer')?.getAttribute('aria-busy')).toBe('true');

    await push(stream, sseFrame('done', chatDone()));
    expect(text(element)).toContain('Complete');
    expect(text(element)).toContain('Model example-chat · 1.2 s');
    expect(liveRegion()).toBe('Answer complete. Cites source 1.');
    expect(button('Cancel answer')).toBeUndefined();
    expect(element.querySelector('section.answer')?.getAttribute('aria-busy')).toBe('false');
    const badges = Array.from(element.querySelectorAll('[data-source]')).map((li) =>
      text(li.querySelector('.source__header')),
    );
    expect(badges).toEqual(['[1] guide-1.md ✓ Cited', '[2] guide-2.md – Not cited']);
  });

  it('shows source cards with heading path, labelled score, excerpt and a chunk deep link', async () => {
    await open();
    const long = 'x'.repeat(400);
    const stream = await ask();
    await push(stream, sseFrame('sources', { sources: [chatSource(1, { content: long })] }));

    const card = required(element.querySelector('[data-source="1"]'), 'source card');
    expect(text(card.querySelector('h4'))).toBe('[1] guide-1.md');
    const meta = Array.from(card.querySelectorAll('dt')).map((dt) => [
      text(dt),
      text(dt.nextElementSibling),
    ]);
    expect(meta).toEqual([
      ['Language', 'markdown'],
      ['Section', 'Guide › Part 1'],
      ['score', '0.800 (distance 0.200)'],
      ['Chunk', '#0'],
    ]);
    expect(text(element.querySelector('.explain'))).toContain('score = cosine similarity');
    expect(text(card.querySelector('.excerpt'))).toBe(`${'x'.repeat(280)}…`);
    expect(text(card.querySelector('details .excerpt'))).toBe(long);

    const link = required(card.querySelector('a'), 'document link');
    expect(link.getAttribute('href')).toBe(
      `/knowledge-bases/${COLLECTION_ID}/documents/${DOCUMENT_ID}?chunk=${chatSource(1).chunkId}`,
    );
    expect(link.getAttribute('aria-label')).toBe('Open source 1 in guide-1.md');
  });

  it('links only delivered citations and highlights the source on click', async () => {
    await open();
    const stream = await ask();
    await push(
      stream,
      sseFrame('sources', { sources: [chatSource(1), chatSource(2)] }),
      sseFrame('token', { text: 'A [2] and B [1, 7] and C [9].' }),
      sseFrame('done', chatDone({ citedSources: [1, 2], unknownCitations: [7, 9] })),
    );

    const answer = required(element.querySelector('[data-testid="answer"]'), 'answer');
    expect(text(answer)).toBe(
      'A [2] and B [1, ⚠ 7 (unknown source)] and C [⚠ 9 (unknown source)].',
    );
    const citeButtons = Array.from(answer.querySelectorAll('button'));
    expect(citeButtons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Source 2: guide-2.md',
      'Source 1: guide-1.md',
    ]);
    // Unknown numbers are marked, never buttons or links.
    expect(answer.querySelectorAll('[data-unknown-cite]')).toHaveLength(2);
    expect(answer.querySelector('a')).toBeNull();
    expect(text(element.querySelector('[data-testid="unknown-citations"]'))).toContain(
      'not given: [7], [9]',
    );

    citeButtons[0]?.click();
    TestBed.tick();
    const card = required(element.querySelector('[data-source="2"]'), 'source 2');
    expect(card.getAttribute('aria-current')).toBe('true');
    expect(text(card)).toContain('Selected');
    expect(document.activeElement).toBe(card);
    expect(element.querySelector('[data-source="1"]')?.getAttribute('aria-current')).toBeNull();
  });

  it('renders HTML in answers and sources as text', async () => {
    await open();
    const payload = '<img src=x onerror="window.__xss=1">';
    const stream = await ask(`${payload} question`);
    await push(
      stream,
      sseFrame('sources', {
        sources: [chatSource(1, { filename: `${payload}.md`, content: payload })],
      }),
      sseFrame('token', { text: `${payload} [1]` }),
      sseFrame('done', chatDone()),
    );

    expect(element.querySelector('img')).toBeNull();
    expect(text(element.querySelector('[data-testid="answer"]'))).toContain(payload);
    expect(text(element.querySelector('[data-source="1"] .excerpt'))).toBe(payload);
    expect(text(element.querySelector('.question'))).toBe(`${payload} question`);
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  it('Shift+Enter adds a line instead of sending; blank questions are not sent', async () => {
    await open();
    type('   ');
    press('Enter');
    expect(fake.requests).toHaveLength(0);

    type('Line one');
    const event = press('Enter', { shiftKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(fake.requests).toHaveLength(0);
  });

  it('Escape cancels a streaming answer and keeps the partial text', async () => {
    await open();
    const stream = await ask();
    await push(
      stream,
      sseFrame('sources', { sources: [chatSource(1)] }),
      sseFrame('token', { text: 'Partial' }),
    );

    press('Escape');
    await render();
    expect(fake.requests[0]?.init.signal?.aborted).toBe(true);
    expect(text(element)).toContain('Cancelled');
    expect(text(element.querySelector('[data-testid="aborted"]'))).toBe(
      '■ You cancelled this answer – it is incomplete.',
    );
    expect(liveRegion()).toBe('Answer cancelled.');
    expect(button('Cancel answer')).toBeUndefined();

    // The UI stays usable: a new question can be sent.
    type('Next');
    expect(sendButton().disabled).toBe(false);
  });

  it('the Cancel button aborts and returns the focus to the question field', async () => {
    await open();
    await ask();
    required(button('Cancel answer')).click();
    await render();

    expect(fake.requests[0]?.init.signal?.aborted).toBe(true);
    expect(document.activeElement).toBe(textarea());
    // "Try again" asks again.
    required(button('Try again')).click();
    await render();
    expect(fake.requests).toHaveLength(2);
  });

  it('shows no_sources distinctly', async () => {
    await open();
    const stream = await ask();
    await push(
      stream,
      sseFrame('sources', { sources: [] }),
      sseFrame('token', { text: 'No matching sources were found in this collection.' }),
      sseFrame('done', chatDone({ answerStatus: 'no_sources', citedSources: [], model: null })),
    );

    const box = required(element.querySelector('[data-testid="no-sources"]'), 'no-sources box');
    expect(text(box)).toContain('No matching sources.');
    expect(text(box)).toContain('The question was not sent to the chat model.');
    expect(text(element)).toContain('No sources found');
    expect(element.querySelector('[data-testid="answer"]')).toBeNull();
    expect(element.querySelector('[data-source]')).toBeNull();
    expect(liveRegion()).toContain('No matching sources found');
  });

  it.each([
    [409, 'EMBEDDING_MODEL_MISMATCH', 'Error code EMBEDDING_MODEL_MISMATCH (HTTP 409)'],
    [404, 'COLLECTION_NOT_FOUND', 'Choose another one'],
    [503, 'EMBEDDING_PROVIDER_UNAVAILABLE', 'Error code EMBEDDING_PROVIDER_UNAVAILABLE (HTTP 503)'],
  ])('shows %i %s before the stream with "Try again"', async (status, code, hint) => {
    await open();
    type('Question');
    press('Enter');
    await render();
    fake.respondJson(status, apiError(code, 'Server says no'));
    await render();
    if (code === 'COLLECTION_NOT_FOUND') {
      // The list is refreshed so the picker no longer offers the deleted knowledge base.
      http.expectOne('/api/collections').flush({ items: defaultCollections().slice(1) });
      await render();
    }

    const alert = required(element.querySelector('[data-error-kind="request"]'), 'alert');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(text(alert)).toContain('The question could not be answered. Server says no');
    expect(text(alert)).toContain(hint);
    expect(text(element)).toContain('Failed');

    required(button('Try again')).click();
    await render();
    expect(fake.requests).toHaveLength(2);
  });

  it('offers "Edit question" for validation errors', async () => {
    await open();
    type('Too long');
    press('Enter');
    await render();
    fake.respondJson(400, apiError('VALIDATION_ERROR', 'question must not be longer than 2000'));
    await render();

    expect(button('Try again')).toBeUndefined();
    required(button('Edit question')).click();
    TestBed.tick();
    expect(textarea().value).toBe('Too long');
    expect(document.activeElement).toBe(textarea());
  });

  it('distinguishes error events, network errors and interrupted streams', async () => {
    await open();
    let stream = await ask();
    await push(
      stream,
      sseFrame('sources', { sources: [chatSource(1)] }),
      sseFrame('error', { code: 'CHAT_PROVIDER_ERROR', message: 'Model "x" is not installed.' }),
    );
    expect(text(element.querySelector('[data-error-kind="stream"]'))).toContain(
      'The chat model could not generate an answer. Model "x" is not installed.',
    );

    type('Second');
    press('Enter');
    await render();
    fake.failNetwork();
    await render();
    expect(text(element.querySelector('[data-error-kind="network"]'))).toContain(
      'The API is not reachable.',
    );

    type('Third');
    press('Enter');
    await render();
    stream = fake.respondStream();
    await push(
      stream,
      sseFrame('sources', { sources: [chatSource(1)] }),
      sseFrame('token', { text: 'Half' }),
    );
    stream.fail();
    await render();
    const interrupted = text(element.querySelector('[data-error-kind="interrupted"]'));
    expect(interrupted).toContain('The connection was interrupted.');
    expect(interrupted).toContain('The text above is incomplete.');
  });

  it('"New chat" cancels and clears the conversation', async () => {
    await open();
    await ask();
    expect(element.querySelectorAll('rl-chat-message')).toHaveLength(1);

    required(button('New chat')).click();
    await render();
    expect(fake.requests[0]?.init.signal?.aborted).toBe(true);
    expect(element.querySelectorAll('rl-chat-message')).toHaveLength(0);
    expect(text(element)).toContain('How it works');
    expect(required(button('New chat')).disabled).toBe(true);
    expect(document.activeElement).toBe(textarea());
  });
});
