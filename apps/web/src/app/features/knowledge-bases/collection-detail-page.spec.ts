import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { DocumentDto, ProvidersStatusResponse } from '@raglab/shared';
import {
  COLLECTION_ID,
  DOCUMENT_ID,
  apiError,
  collection,
  document as documentDto,
  providersOk,
  systemInfo,
  text,
  required,
} from '../../../testing/fixtures';
import { POLL_INTERVAL_MS } from '../../core/util/polling';
import { CollectionDetailPage } from './collection-detail-page';

const DOCUMENTS_URL = `/api/collections/${COLLECTION_ID}/documents`;
const COLLECTION_URL = `/api/collections/${COLLECTION_ID}`;

describe('CollectionDetailPage', () => {
  let fixture: ComponentFixture<CollectionDetailPage>;
  let http: HttpTestingController;
  let element: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: POLL_INTERVAL_MS, useValue: 2000 },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CollectionDetailPage);
    fixture.componentRef.setInput('collectionId', COLLECTION_ID);
    element = fixture.nativeElement as HTMLElement;
    document.body.appendChild(element);
    TestBed.tick();
  });

  afterEach(() => {
    fixture.destroy();
    element.remove();
    http.verify();
    vi.useRealTimers();
  });

  /** Lets awaited promises continue and renders (fake timers: no automatic change detection). */
  async function render(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();
  }

  /** Advances the fake clock (poll timers fire) and runs change detection and effects. */
  async function elapse(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    TestBed.tick();
  }

  async function load(
    documents: DocumentDto[],
    providers: ProvidersStatusResponse = providersOk,
  ): Promise<void> {
    http.expectOne(COLLECTION_URL).flush(collection());
    http.expectOne(DOCUMENTS_URL).flush({ items: documents });
    http.expectOne('/api/system/providers').flush(providers);
    await render();
    http.expectOne('/api/system/info').flush(systemInfo);
    await render();
  }

  const button = (name: string, root: ParentNode = element) =>
    Array.from(root.querySelectorAll('button')).find((b) => text(b).includes(name));

  it('shows the collection header with embedding model and dimensions', async () => {
    await load([documentDto()]);

    expect(text(element.querySelector('h1'))).toBe('Project docs');
    expect(text(element)).toContain('Architecture notes');
    const facts = text(element.querySelector('dl'));
    expect(facts).toContain('example-embed');
    expect(facts).toContain('768');
    expect(element.querySelector('nav[aria-label="Breadcrumb"] a')?.getAttribute('href')).toBe(
      '/knowledge-bases',
    );
  });

  it('renders documents in a semantic table with status text and error messages', async () => {
    await load([
      documentDto(),
      documentDto({
        id: 'failed-id',
        filename: 'broken.md',
        status: 'failed',
        chunkCount: 0,
        errorMessage: 'Embedding failed: Embedding model "x" is not installed in Ollama.',
      }),
    ]);

    const table = element.querySelector('table');
    expect(text(table?.querySelector('caption'))).toBe('Documents: 2 documents, 1 failed');
    expect(
      Array.from(table?.querySelectorAll('thead th') ?? []).map((th) => th.getAttribute('scope')),
    ).toEqual(['col', 'col', 'col', 'col', 'col', 'col']);
    const rows = Array.from(table?.querySelectorAll('tbody tr') ?? []);
    expect(text(rows[0])).toContain('Ready');
    expect(text(rows[0])).toContain('2 KiB');
    expect(text(rows[1])).toContain('Failed');
    expect(text(rows[1])).toContain('is not installed in Ollama');
    // Reindex only for failed documents; accessible names include the file name.
    expect(button('Reindex', required(rows[0]))).toBeUndefined();
    expect(text(button('Reindex', required(rows[1])))).toBe('↻ Reindex broken.md');
  });

  it('shows an empty state without documents', async () => {
    await load([]);
    expect(text(element)).toContain('No documents yet');
  });

  it('warns when the embedding model is missing (as reported by the API)', async () => {
    await load([], {
      ...providersOk,
      embedding: {
        ...providersOk.embedding,
        modelAvailable: false,
        error: 'Embedding model "example-embed" is not installed in Ollama.',
        hint: 'Run "ollama pull example-embed" on the Ollama host.',
      },
    });

    const warning = text(element.querySelector('[data-testid="provider-warning"]'));
    expect(warning).toContain('Indexing will fail');
    expect(warning).toContain('ollama pull example-embed');
  });

  it('polls while documents are pending/processing and stops when all are done', async () => {
    await load([documentDto({ status: 'pending', chunkCount: 0 })]);
    expect(element.querySelector('[data-testid="polling-indicator"]')).not.toBeNull();

    http.expectNone(DOCUMENTS_URL);
    await elapse(2000);
    http.expectOne(DOCUMENTS_URL).flush({ items: [documentDto({ status: 'processing' })] });
    await render();
    expect(text(element.querySelector('tbody'))).toContain('Processing');

    await elapse(2000);
    http.expectOne(DOCUMENTS_URL).flush({ items: [documentDto({ status: 'ready' })] });
    await render();
    // A finished document changes the counts in the header.
    http.expectOne(COLLECTION_URL).flush(collection({ readyDocumentCount: 2 }));
    await render();

    expect(text(element.querySelector('tbody'))).toContain('Ready');
    expect(text(element.querySelector('[aria-live="polite"]'))).toContain('“notes.md”: ready.');
    expect(element.querySelector('[data-testid="polling-indicator"]')).toBeNull();

    await elapse(10_000);
    http.expectNone(DOCUMENTS_URL);
  });

  it('stops polling when the page is left', async () => {
    await load([documentDto({ status: 'processing' })]);

    fixture.destroy();
    await elapse(10_000);

    http.expectNone(DOCUMENTS_URL);
  });

  it('reindexes a failed document and starts polling again', async () => {
    await load([documentDto({ status: 'failed', errorMessage: 'boom' })]);

    button('Reindex')?.click();
    const request = http.expectOne({
      method: 'POST',
      url: `/api/documents/${DOCUMENT_ID}/reindex`,
    });
    request.flush(documentDto({ status: 'pending' }), { status: 202, statusText: 'Accepted' });
    await render();

    expect(text(element.querySelector('tbody'))).toContain('Pending');
    await elapse(2000);
    http.expectOne(DOCUMENTS_URL).flush({ items: [documentDto({ status: 'failed' })] });
    await render();
    http.expectOne(COLLECTION_URL).flush(collection());
  });

  it('confirms before deleting the collection and names the affected documents', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    await load([documentDto()]);

    button('Delete knowledge base')?.click();
    await render();
    const dialog = element.querySelector('dialog');
    expect(dialog?.hasAttribute('open')).toBe(true);
    expect(text(dialog)).toContain('“Project docs” with 2 documents and 12 chunks');

    button('Cancel', required(dialog))?.click();
    await render();
    expect(dialog?.hasAttribute('open')).toBe(false);
    http.expectNone({ method: 'DELETE', url: COLLECTION_URL });

    button('Delete knowledge base')?.click();
    await render();
    Array.from(required(dialog).querySelectorAll('button'))
      .find((b) => text(b) === 'Delete')
      ?.click();
    http
      .expectOne({ method: 'DELETE', url: COLLECTION_URL })
      .flush(null, { status: 204, statusText: 'No Content' });
    await render();

    expect(navigate).toHaveBeenCalledWith(['/knowledge-bases']);
  });

  it('deletes a document after confirmation and shows errors inside the dialog', async () => {
    await load([documentDto()]);

    button('Delete notes.md')?.click();
    await render();
    const dialog = required(element.querySelector('dialog'));
    expect(text(dialog)).toContain('“notes.md” and all of its chunks');

    Array.from(dialog.querySelectorAll('button'))
      .find((b) => text(b) === 'Delete')
      ?.click();
    http
      .expectOne({ method: 'DELETE', url: `/api/documents/${DOCUMENT_ID}` })
      .flush(apiError('INTERNAL_ERROR', 'Database down'), { status: 500, statusText: 'Error' });
    await render();
    expect(text(dialog.querySelector('[role="alert"]'))).toContain('Database down');

    Array.from(dialog.querySelectorAll('button'))
      .find((b) => text(b) === 'Delete')
      ?.click();
    http
      .expectOne({ method: 'DELETE', url: `/api/documents/${DOCUMENT_ID}` })
      .flush(null, { status: 204, statusText: 'No Content' });
    await render();
    http.expectOne(DOCUMENTS_URL).flush({ items: [] });
    http.expectOne(COLLECTION_URL).flush(collection({ documentCount: 0 }));
    await render();

    expect(dialog.hasAttribute('open')).toBe(false);
    expect(text(element)).toContain('No documents yet');
  });

  it('edits name and description', async () => {
    await load([]);

    button('Edit')?.click();
    await render();
    const input = required(element.querySelector<HTMLInputElement>('input[name="name"]'));
    expect(input.value).toBe('Project docs');
    input.value = 'Renamed';
    input.dispatchEvent(new Event('input'));
    element.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    TestBed.tick();

    const request = http.expectOne({ method: 'PATCH', url: COLLECTION_URL });
    expect(request.request.body).toEqual({ name: 'Renamed', description: 'Architecture notes' });
    request.flush(collection({ name: 'Renamed' }));
    await render();

    expect(text(element.querySelector('h1'))).toBe('Renamed');
  });

  it('shows "not found" for an unknown collection', async () => {
    http
      .expectOne(COLLECTION_URL)
      .flush(apiError('COLLECTION_NOT_FOUND', 'Collection does not exist'), {
        status: 404,
        statusText: 'Not Found',
      });
    http
      .expectOne(DOCUMENTS_URL)
      .flush(apiError('COLLECTION_NOT_FOUND', 'Collection does not exist'), {
        status: 404,
        statusText: 'Not Found',
      });
    http.expectOne('/api/system/providers').flush(providersOk);
    await render();

    expect(text(element.querySelector('h1'))).toBe('Knowledge base not found');
  });
});
