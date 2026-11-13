import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { ChunkDto, DocumentDto } from '@raglab/shared';
import {
  COLLECTION_ID,
  DOCUMENT_ID,
  apiError,
  chunk,
  collection,
  document as documentDto,
  text,
  required,
} from '../../../testing/fixtures';
import { DocumentDetailPage } from './document-detail-page';

const DOCUMENT_URL = `/api/documents/${DOCUMENT_ID}`;
const HOSTILE_TEXT = '<img src=x onerror="alert(1)"><script>alert(2)</script> **bold**';

describe('DocumentDetailPage', () => {
  let fixture: ComponentFixture<DocumentDetailPage>;
  let http: HttpTestingController;
  let element: HTMLElement;

  function create(chunkParam?: string): void {
    fixture = TestBed.createComponent(DocumentDetailPage);
    fixture.componentRef.setInput('collectionId', COLLECTION_ID);
    fixture.componentRef.setInput('documentId', DOCUMENT_ID);
    if (chunkParam) {
      fixture.componentRef.setInput('chunk', chunkParam);
    }
    element = fixture.nativeElement as HTMLElement;
    document.body.appendChild(element);
    TestBed.tick();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    fixture.destroy();
    element.remove();
    http.verify();
    vi.useRealTimers();
  });

  async function load(
    doc: DocumentDto = documentDto(),
    chunks: ChunkDto[] = [chunk(0), chunk(1, { hasEmbedding: false, headingPath: [] })],
  ): Promise<void> {
    http.expectOne(`/api/collections/${COLLECTION_ID}`).flush(collection());
    http.expectOne(DOCUMENT_URL).flush(doc);
    http
      .expectOne(`${DOCUMENT_URL}/content`)
      .flush({ documentId: DOCUMENT_ID, content: HOSTILE_TEXT });
    http.expectOne(`${DOCUMENT_URL}/chunks`).flush({ documentId: DOCUMENT_ID, chunks });
    await fixture.whenStable();
  }

  it('shows metadata and breadcrumbs', async () => {
    create();
    await load(documentDto({ metadata: { title: 'The Guide' } }));

    expect(text(element.querySelector('h1'))).toBe('notes.md');
    expect(text(element)).toContain('Title: The Guide');
    const metadata = text(element.querySelector('section[aria-labelledby="metadata-heading"]'));
    expect(metadata).toContain('Ready');
    expect(metadata).toContain('2 KiB (2048 bytes)');
    expect(metadata).toContain('text/markdown');
    expect(metadata).toContain('a'.repeat(64));
    const crumbs = Array.from(element.querySelectorAll('nav[aria-label="Breadcrumb"] li')).map(
      text,
    );
    expect(crumbs).toEqual(['Knowledge Bases', 'Project docs', 'notes.md']);
  });

  it('renders the full text as text, never as HTML', async () => {
    create();
    await load();

    const fulltext = element.querySelector('[data-testid="fulltext"]');
    expect(fulltext?.textContent).toBe(HOSTILE_TEXT);
    expect(fulltext?.querySelector('img, script, strong')).toBeNull();
    expect(fulltext?.getAttribute('aria-label')).toBe('Normalized full text');
  });

  it('lists chunks with index, offsets, heading path, characters and embedding state', async () => {
    create();
    await load();

    const items = Array.from(element.querySelectorAll('ol.chunks > li'));
    expect(items).toHaveLength(2);
    const first = text(items[0]);
    expect(first).toContain('Chunk #0');
    expect(first).toContain('Embedding stored');
    expect(first).toContain('0–15');
    expect(first).toContain('Guide › Setup');
    expect(first).toContain('15 (≈ 4 tokens, estimate)');
    const second = text(items[1]);
    expect(second).toContain('No embedding');
    expect(second).toContain('none');
    expect(text(element)).toContain('2 chunks, 1 with embedding.');
  });

  describe('source code documents', () => {
    const CODE = 'export class Tree {\n  // <b>not bold</b>\n}\n\nexport function grow() {}\n';
    const codeDoc = documentDto({
      filename: 'tree.ts',
      path: 'packages/table/src/tree.ts',
      language: 'typescript',
      mimeType: 'text/plain',
    });
    const codeChunks = [
      chunk(0, {
        content: 'export class Tree {\n  // <b>not bold</b>\n}\n',
        headingPath: ['packages/table/src/tree.ts', 'class Tree'],
        startLine: 1,
        endLine: 3,
        symbol: 'class Tree',
      }),
      chunk(1, {
        content: 'export function grow() {}\n',
        headingPath: ['packages/table/src/tree.ts', 'function grow'],
        startLine: 5,
        endLine: 5,
        symbol: 'function grow',
      }),
    ];

    async function loadCode(): Promise<void> {
      http.expectOne(`/api/collections/${COLLECTION_ID}`).flush(collection());
      http.expectOne(DOCUMENT_URL).flush(codeDoc);
      http.expectOne(`${DOCUMENT_URL}/content`).flush({ documentId: DOCUMENT_ID, content: CODE });
      http
        .expectOne(`${DOCUMENT_URL}/chunks`)
        .flush({ documentId: DOCUMENT_ID, chunks: codeChunks });
      await fixture.whenStable();
    }

    it('shows path and language in the header and metadata', async () => {
      create();
      await loadCode();

      expect(text(element.querySelector('[data-testid="document-path"]'))).toBe(
        'packages/table/src/tree.ts',
      );
      const metadata = text(element.querySelector('section[aria-labelledby="metadata-heading"]'));
      expect(metadata).toContain('Pathpackages/table/src/tree.ts');
      expect(metadata).toContain('Languagetypescript');
    });

    it('renders code as text with line numbers and visible chunk boundaries', async () => {
      create();
      await loadCode();

      const view = required(element.querySelector('[data-testid="code-view"]'));
      expect(element.querySelector('[data-testid="fulltext"]')).toBeNull();
      const lines = Array.from(view.querySelectorAll('.code__line'));
      expect(lines).toHaveLength(5);
      expect(lines.map((line) => text(line.querySelector('.code__ln')))).toEqual([
        '1',
        '2',
        '3',
        '4',
        '5',
      ]);
      expect(lines[1]?.querySelector('.code__text')?.textContent).toBe('  // <b>not bold</b>');
      expect(view.querySelector('b')).toBeNull();
      expect(lines[0]?.querySelector('.code__ln')?.getAttribute('aria-hidden')).toBe('true');
      expect(Array.from(view.querySelectorAll('[data-testid="chunk-boundary"]')).map(text)).toEqual(
        ['Chunk #0 starts at line 1', 'Chunk #1 starts at line 5'],
      );
      expect(text(element)).toContain('5 lines');
    });

    it('lists chunks with path:lines and symbol instead of the heading path', async () => {
      create();
      await loadCode();

      const items = Array.from(element.querySelectorAll('ol.chunks > li'));
      expect(text(items[0]?.querySelector('[data-testid="chunk-location"]'))).toBe(
        'packages/table/src/tree.ts:1–3',
      );
      expect(text(items[1]?.querySelector('[data-testid="chunk-location"]'))).toBe(
        'packages/table/src/tree.ts:5',
      );
      expect(text(items[0])).toContain('Symbolclass Tree');
      expect(text(items[0])).not.toContain('Heading path');
      expect(items[0]?.querySelector('pre')?.classList).toContain('chunk__content--code');
    });

    it('highlights the lines of a deep-linked chunk', async () => {
      HTMLElement.prototype.scrollIntoView = vi.fn();
      create(codeChunks[1]?.id);
      await loadCode();

      const linked = Array.from(element.querySelectorAll('.code__line--linked')).map((line) =>
        line.getAttribute('data-line'),
      );
      expect(linked).toEqual(['5']);
    });
  });

  it('shows no location for chunks without line numbers', async () => {
    create();
    await load();
    expect(element.querySelector('[data-testid="chunk-location"]')).toBeNull();
    expect(element.querySelector('[data-testid="code-view"]')).toBeNull();
  });

  it('scrolls to, focuses and highlights a deep-linked chunk', async () => {
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const target = chunk(1);
    create(target.id);
    await load(documentDto(), [chunk(0), target]);

    const linked = element.querySelector<HTMLElement>(`[data-chunk-id="${target.id}"]`);
    expect(linked?.classList).toContain('is-linked');
    expect(linked?.getAttribute('aria-current')).toBe('true');
    expect(text(linked)).toContain('Linked chunk');
    expect(document.activeElement).toBe(linked);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(element.querySelectorAll('.is-linked')).toHaveLength(1);
    // jsdom has no scrollIntoView; remove the stub again.
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  });

  it('says so when the linked chunk does not exist', async () => {
    create('0190a8c4-0000-7000-8000-00000000ffff');
    await load();

    expect(text(element.querySelector('[role="alert"]'))).toContain(
      'The linked chunk does not exist',
    );
  });

  it('polls a document that is still processing and reloads chunks when it is done', async () => {
    vi.useFakeTimers();
    create();
    http.expectOne(`/api/collections/${COLLECTION_ID}`).flush(collection());
    http.expectOne(DOCUMENT_URL).flush(documentDto({ status: 'processing', chunkCount: 0 }));
    http.expectOne(`${DOCUMENT_URL}/content`).flush({ documentId: DOCUMENT_ID, content: 'x' });
    http.expectOne(`${DOCUMENT_URL}/chunks`).flush({ documentId: DOCUMENT_ID, chunks: [] });
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();
    expect(text(element)).toContain('No chunks yet');

    await vi.advanceTimersByTimeAsync(2000);
    TestBed.tick();
    http.expectOne(DOCUMENT_URL).flush(documentDto({ status: 'ready' }));
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();
    http.expectOne(`${DOCUMENT_URL}/chunks`).flush({ documentId: DOCUMENT_ID, chunks: [chunk(0)] });
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();

    expect(text(element.querySelector('[aria-live="polite"]'))).toContain('“notes.md”: ready.');
    expect(element.querySelectorAll('ol.chunks > li')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    TestBed.tick();
    http.expectNone(DOCUMENT_URL);
  });

  it('shows "not found" for unknown documents and documents of another collection', async () => {
    create();
    http.expectOne(`/api/collections/${COLLECTION_ID}`).flush(collection());
    http.expectOne(DOCUMENT_URL).flush(documentDto({ collectionId: 'other' }));
    http.expectOne(`${DOCUMENT_URL}/content`).flush({ documentId: DOCUMENT_ID, content: 'x' });
    http.expectOne(`${DOCUMENT_URL}/chunks`).flush({ documentId: DOCUMENT_ID, chunks: [] });
    await fixture.whenStable();
    expect(text(element.querySelector('h1'))).toBe('Document not found');

    fixture.componentRef.setInput('documentId', 'missing');
    TestBed.tick();
    http
      .expectOne('/api/documents/missing')
      .flush(apiError('DOCUMENT_NOT_FOUND', 'Document missing does not exist'), {
        status: 404,
        statusText: 'Not Found',
      });
    http.expectOne('/api/documents/missing/content').flush(apiError('DOCUMENT_NOT_FOUND', 'x'), {
      status: 404,
      statusText: 'Not Found',
    });
    http.expectOne('/api/documents/missing/chunks').flush(apiError('DOCUMENT_NOT_FOUND', 'x'), {
      status: 404,
      statusText: 'Not Found',
    });
    await fixture.whenStable();
    expect(text(element.querySelector('h1'))).toBe('Document not found');
  });

  it('deletes the document after confirmation and returns to the collection', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    create();
    await load();

    Array.from(element.querySelectorAll('button'))
      .find((b) => text(b) === 'Delete document')
      ?.click();
    await fixture.whenStable();
    const dialog = required(element.querySelector('dialog'));
    expect(dialog.hasAttribute('open')).toBe(true);
    Array.from(dialog.querySelectorAll('button'))
      .find((b) => text(b) === 'Delete')
      ?.click();
    http
      .expectOne({ method: 'DELETE', url: DOCUMENT_URL })
      .flush(null, { status: 204, statusText: 'No Content' });
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();

    expect(navigate).toHaveBeenCalledWith(['/knowledge-bases', COLLECTION_ID]);
  });
});
