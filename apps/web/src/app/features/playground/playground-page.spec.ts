import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import type { CollectionDto, PlaygroundSearchResponse } from '@raglab/shared';
import {
  COLLECTION_ID,
  apiError,
  collection,
  playgroundResponse,
  playgroundResult,
  required,
  systemInfo,
  text,
} from '../../../testing/fixtures';
import { settle } from '../../../testing/fake-fetch';
import { PlaygroundPage } from './playground-page';
import { CLIPBOARD_WRITE } from './prompt-preview';

const OTHER_ID = '0190a8c4-0000-7000-8000-000000000009';

describe('PlaygroundPage', () => {
  let fixture: ComponentFixture<PlaygroundPage>;
  let http: HttpTestingController;
  let element: HTMLElement;
  let navigate: ReturnType<typeof vi.spyOn>;
  let copied: string[];

  beforeEach(() => {
    copied = [];
    TestBed.configureTestingModule({
      providers: [
        provideRouter([], withComponentInputBinding()),
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: CLIPBOARD_WRITE,
          useValue: async (value: string) => {
            copied.push(value);
          },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  });

  afterEach(() => {
    fixture.destroy();
    element.remove();
    http.verify();
  });

  async function render(): Promise<void> {
    await settle();
    TestBed.tick();
  }

  async function open(
    params: Record<string, string> = {},
    collections: CollectionDto[] = [
      collection(),
      collection({ id: OTHER_ID, name: 'Empty', readyDocumentCount: 0, documentCount: 0 }),
    ],
  ): Promise<void> {
    fixture = TestBed.createComponent(PlaygroundPage);
    for (const [key, value] of Object.entries(params)) {
      fixture.componentRef.setInput(key, value);
    }
    element = fixture.nativeElement as HTMLElement;
    document.body.appendChild(element);
    TestBed.tick();
    http.expectOne('/api/collections').flush({ items: collections });
    http.expectOne('/api/system/info').flush(systemInfo);
    await render();
  }

  /** Answers the pending search request and returns its body. */
  async function respond(
    body: PlaygroundSearchResponse | { status: number; error: object } = playgroundResponse(),
  ): Promise<unknown> {
    const request = http.expectOne({ method: 'POST', url: '/api/playground/search' });
    if ('status' in body) {
      request.flush(body.error, { status: body.status, statusText: 'Error' });
    } else {
      request.flush(body);
    }
    await render();
    return request.request.body;
  }

  const field = <T extends HTMLElement>(selector: string) =>
    required(element.querySelector<T>(selector), selector);
  const button = (name: string) =>
    Array.from(element.querySelectorAll('button')).find((b) => text(b).includes(name));
  const liveRegion = () => text(element.querySelector('[role="status"][aria-live="polite"]'));

  function input(selector: string, value: string): void {
    const target = field<HTMLInputElement | HTMLTextAreaElement>(selector);
    target.value = value;
    target.dispatchEvent(new Event('input'));
    TestBed.tick();
  }

  function submit(): void {
    field<HTMLFormElement>('form').dispatchEvent(new Event('submit', { cancelable: true }));
    TestBed.tick();
  }

  it('shows the form with all knowledge bases and an explanation, without searching', async () => {
    await open();

    expect(text(element.querySelector('h1'))).toBe('Retrieval Playground');
    const options = Array.from(field<HTMLSelectElement>('#pg-collection').options);
    expect(options.map((o) => text(o))).toEqual([
      'Choose a knowledge base',
      'Project docs',
      'Empty (no ready documents)',
    ]);
    expect(text(element)).toContain('How it works');
    expect(text(element.querySelector('#pg-topk-hint'))).toContain('Empty: server default (8)');
    expect(text(element.querySelector('#pg-query-hint'))).toContain('0 / 2000 characters');
    http.expectNone('/api/playground/search');
  });

  it('writes the form into the query parameters on search', async () => {
    await open();
    const select = field<HTMLSelectElement>('#pg-collection');
    select.value = COLLECTION_ID;
    select.dispatchEvent(new Event('change'));
    input('#pg-query', '  How do I reindex?  ');
    input('#pg-topk', '5');
    input('#pg-minscore', '0.5');
    const checkbox = field<HTMLInputElement>('#pg-prompt');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    TestBed.tick();

    submit();

    expect(navigate).toHaveBeenCalledWith([], {
      queryParams: {
        collection: COLLECTION_ID,
        q: 'How do I reindex?',
        topK: '5',
        minScore: '0.5',
        prompt: '1',
      },
    });
  });

  it('validates the form, marks invalid fields and focuses the first one', async () => {
    await open();
    input('#pg-topk', '101');
    input('#pg-minscore', '2');

    submit();

    expect(navigate).not.toHaveBeenCalled();
    expect(text(element.querySelector('#pg-collection-error'))).toBe('Choose a knowledge base.');
    expect(text(element.querySelector('#pg-query-error'))).toBe('Enter a query.');
    expect(text(element.querySelector('#pg-topk-error'))).toContain('from 1 to 100');
    expect(text(element.querySelector('#pg-minscore-error'))).toContain('from −1 to 1');
    expect(field('#pg-query').getAttribute('aria-invalid')).toBe('true');
    expect(field('#pg-query').getAttribute('aria-describedby')).toBe(
      'pg-query-hint pg-query-error',
    );
    expect(document.activeElement).toBe(field('#pg-collection'));

    input('#pg-query', 'x'.repeat(2001));
    expect(text(element.querySelector('#pg-query-error'))).toContain(
      'must not be longer than 2000 characters',
    );
  });

  it('restores a search from the query parameters (reload) and shows flagged results', async () => {
    await open({ collection: COLLECTION_ID, q: 'How do I reindex?', topK: '4', minScore: '0.6' });

    expect(field<HTMLSelectElement>('#pg-collection').value).toBe(COLLECTION_ID);
    expect(field<HTMLTextAreaElement>('#pg-query').value).toBe('How do I reindex?');
    expect(field<HTMLInputElement>('#pg-topk').value).toBe('4');
    expect(text(element)).toContain('Searching…');
    const body = await respond();
    expect(body).toEqual({
      collectionId: COLLECTION_ID,
      query: 'How do I reindex?',
      topK: 4,
      minScore: 0.6,
    });

    const table = field<HTMLTableElement>('table');
    expect(text(table.querySelector('caption'))).toBe('Top 4 chunks by ascending distance');
    const headers = Array.from(table.querySelectorAll('thead th')).map((th) => text(th));
    expect(headers).toEqual([
      'Rank',
      'Score',
      'Distance',
      'Source',
      'Chunk',
      'Chat context',
      'Details',
    ]);
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(4);
    expect(text(rows[0])).toContain('0.850');
    expect(text(rows[0])).toContain('0.150');
    expect(text(rows[0])).toContain('guide-1.md');
    expect(text(rows[0])).toContain('Guide › Part 1');
    expect(text(rows[0])).toContain('In chat context');
    expect(text(rows[2])).toContain('Outside budget');
    expect(text(rows[3])).toContain('Below minScore');
    // The score bar is decoration; the number is always shown.
    const bar = required(rows[0]?.querySelector<HTMLElement>('.score__bar'));
    expect(bar.getAttribute('aria-hidden')).toBe('true');
    expect(required(bar.querySelector<HTMLElement>('span')).style.width).toBe('85%');
    expect(text(element.querySelector('#pg-score-help'))).toContain(
      'score = 1 − cosine distance, higher is more similar',
    );
    expect(text(element.querySelector('.summary'))).toBe(
      '4 results · 2 in chat context · 1 outside budget · 1 below minScore.',
    );
    expect(liveRegion()).toContain('4 results · 2 in chat context');
  });

  it('expands a chunk with its full text, offsets and a deep link', async () => {
    await open({ collection: COLLECTION_ID, q: 'q' });
    await respond(
      playgroundResponse({
        results: [playgroundResult(1, { content: '<b>not html</b>\nsecond line' })],
      }),
    );

    const toggle = required(button('Show'));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    TestBed.tick();

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const detail = field(`#${toggle.getAttribute('aria-controls') ?? ''}`);
    const excerpt = required(detail.querySelector('.excerpt'));
    expect(excerpt.textContent).toBe('<b>not html</b>\nsecond line');
    expect(excerpt.querySelector('b')).toBeNull();
    expect(text(detail)).toContain('100–131');
    const link = required(detail.querySelector('a'));
    expect(link.getAttribute('href')).toBe(
      `/knowledge-bases/${COLLECTION_ID}/documents/0190a8c4-0000-7000-8000-000000000002?chunk=0190a8c4-0000-7000-8000-000000000301`,
    );

    toggle.click();
    TestBed.tick();
    expect(element.querySelector('.excerpt')).toBeNull();
  });

  it('shows diagnostics and warnings', async () => {
    await open({ collection: COLLECTION_ID, q: 'q' });
    await respond(
      playgroundResponse({
        warnings: [
          { code: 'CHUNKS_WITHOUT_EMBEDDING', message: '3 chunks without an embedding …' },
        ],
      }),
    );

    const diagnostics = field('rl-playground-diagnostics');
    expect(text(diagnostics)).toContain('ollama · example-embed · 768 dimensions');
    expect(text(diagnostics)).toContain('Same model');
    expect(text(diagnostics)).toContain('iterative_scan = relaxed_order');
    expect(text(diagnostics)).toContain('ef_search = 40');
    expect(text(diagnostics)).toContain('420 of 12000 characters');
    expect(text(diagnostics)).toContain('12.3 ms');
    expect(text(diagnostics.querySelector('[data-code="CHUNKS_WITHOUT_EMBEDDING"]'))).toBe(
      '3 chunks without an embedding …',
    );
  });

  it.each([
    ['collection_empty', 'This knowledge base has no documents.'],
    ['no_indexed_chunks', 'Nothing can be searched yet.'],
  ] as const)('explains an empty result (%s)', async (emptyReason, message) => {
    await open({ collection: OTHER_ID, q: 'q' });
    await respond(playgroundResponse({ results: [], emptyReason }));

    expect(element.querySelector('table')).toBeNull();
    expect(text(element)).toContain(message);
    expect(text(element.querySelector('.summary'))).toBe(
      'No results – the chat would answer without sources.',
    );
  });

  it('requests and shows the prompt preview, copyable as text', async () => {
    await open({ collection: COLLECTION_ID, q: 'q', prompt: '1' });
    const body = await respond(
      playgroundResponse({
        prompt: {
          messages: [
            { role: 'system', content: 'You are RAGLab.' },
            { role: 'user', content: 'Sources:\n\n<source id="1">x</source>' },
          ],
          wouldCallModel: true,
          chatModel: { provider: 'ollama', model: 'example-chat' },
        },
      }),
    );
    expect(body).toMatchObject({ includePrompt: true });
    expect(field<HTMLInputElement>('#pg-prompt').checked).toBe(true);

    const preview = field('rl-prompt-preview');
    expect(text(preview)).toContain('example-chat');
    const blocks = Array.from(preview.querySelectorAll('pre'));
    expect(blocks.map((pre) => pre.textContent)).toEqual([
      'You are RAGLab.',
      'Sources:\n\n<source id="1">x</source>',
    ]);
    required(button('Copy prompt')).click();
    await render();
    expect(copied).toEqual([
      '### system\n\nYou are RAGLab.\n\n### user\n\nSources:\n\n<source id="1">x</source>',
    ]);
    expect(text(preview.querySelector('[role="status"]'))).toBe('Prompt copied to the clipboard.');
  });

  it('renders HTML and scripts from sources, filenames and the prompt as text', async () => {
    const hostile = '<script>window.__pgXss=1</script><img src=x onerror="window.__pgXss=2">';
    await open({ collection: COLLECTION_ID, q: 'q', prompt: '1' });
    await respond(
      playgroundResponse({
        results: [playgroundResult(1, { filename: `${hostile}.md`, content: hostile })],
        prompt: {
          messages: [
            { role: 'system', content: 'You are RAGLab.' },
            { role: 'user', content: `<source id="1">\n${hostile}\n</source>` },
          ],
          wouldCallModel: true,
          chatModel: { provider: 'ollama', model: 'example-chat' },
        },
      }),
    );
    required(button('Show')).click();
    TestBed.tick();

    expect(element.querySelector('script')).toBeNull();
    expect(element.querySelector('img')).toBeNull();
    expect(text(element.querySelector('table'))).toContain(`${hostile}.md`);
    expect(required(element.querySelector('.excerpt')).textContent).toBe(hostile);
    const blocks = Array.from(field('rl-prompt-preview').querySelectorAll('pre'));
    expect(blocks[1]?.textContent).toBe(`<source id="1">\n${hostile}\n</source>`);
    expect((window as unknown as { __pgXss?: number }).__pgXss).toBeUndefined();
  });

  it('says when the chat would not call the model', async () => {
    await open({ collection: COLLECTION_ID, q: 'q', prompt: '1' });
    await respond(
      playgroundResponse({
        results: [],
        emptyReason: 'collection_empty',
        prompt: {
          messages: [{ role: 'system', content: 'S' }],
          wouldCallModel: false,
          noSourcesAnswer: 'No matching sources were found.',
          chatModel: { provider: 'ollama', model: 'example-chat' },
        },
      }),
    );
    expect(text(field('rl-prompt-preview'))).toContain(
      'the chat would not call the model and answer with this fixed text instead: No matching sources were found.',
    );
  });

  it('explains an embedding model mismatch with both models', async () => {
    await open({ collection: COLLECTION_ID, q: 'q' });
    await respond({
      status: 409,
      error: apiError('EMBEDDING_MODEL_MISMATCH', 'Mismatch.', {
        collectionProvider: 'ollama',
        collectionModel: 'old-embed',
        collectionDimensions: 768,
        providerId: 'ollama',
        providerModel: 'new-embed',
        providerDimensions: 1024,
      }),
    });

    const alert = field('[role="alert"]');
    expect(text(alert)).toContain('Embedding model mismatch');
    expect(text(alert)).toContain('ollama · old-embed · 768 dimensions');
    expect(text(alert)).toContain('ollama · new-embed · 1024 dimensions');
  });

  it('shows provider errors with their hint and retries', async () => {
    await open({ collection: COLLECTION_ID, q: 'q' });
    await respond({
      status: 503,
      error: apiError('EMBEDDING_PROVIDER_UNAVAILABLE', 'Ollama is not reachable.', {
        providerCode: 'PROVIDER_UNREACHABLE',
        hint: 'Start Ollama.',
      }),
    });

    const alert = field('[role="alert"]');
    expect(text(alert)).toContain(
      'The embedding provider is not reachable. Ollama is not reachable.',
    );
    expect(text(alert)).toContain('Start Ollama.');
    required(button('Try again')).click();
    TestBed.tick();
    await respond();
    expect(element.querySelector('table')).not.toBeNull();
  });

  it('reloads the knowledge bases when the searched one no longer exists', async () => {
    await open({ collection: OTHER_ID, q: 'q' });
    await respond({
      status: 404,
      error: apiError('COLLECTION_NOT_FOUND', 'Collection does not exist'),
    });
    expect(text(field('[role="alert"]'))).toContain('The knowledge base does not exist (anymore).');
    http.expectOne('/api/collections').flush({ items: [collection()] });
    await render();
  });

  it('reports a link with invalid values instead of searching', async () => {
    await open({ collection: COLLECTION_ID, q: 'q', topK: 'abc' });

    http.expectNone('/api/playground/search');
    expect(text(field('[role="alert"]'))).toContain('This link cannot be searched');
    expect(text(field('[role="alert"]'))).toContain('Top-K must be a whole number');
  });

  it('searches again for an unchanged form and links to the chat with collection and query', async () => {
    await open({ collection: COLLECTION_ID, q: 'How do I reindex?' });
    await respond();

    submit();
    expect(navigate).not.toHaveBeenCalled();
    await respond();

    const chatLink = required(
      Array.from(element.querySelectorAll('a')).find((a) => text(a).includes('Ask in chat')),
    );
    expect(chatLink.getAttribute('href')).toBe(
      `/chat?collection=${COLLECTION_ID}&q=How%20do%20I%20reindex%3F`,
    );
  });

  it('tells the user to create a knowledge base when there is none', async () => {
    await open({}, []);
    expect(text(element)).toContain('There is no knowledge base yet.');
    expect(element.querySelector('textarea')).toBeNull();
  });
});
