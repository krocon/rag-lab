import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { COLLECTION_ID, DOCUMENT_ID, collection } from '../testing/fixtures';

const OTHER_ID = '0190a8c4-0000-7000-8000-000000000009';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from './app.routes';

describe('routes', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes, withComponentInputBinding()),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
  });

  it('/playground is the playground (not a placeholder) and restores ?collection=&q=', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(`/playground?collection=${OTHER_ID}&q=reindex&topK=3`);
    const element = harness.routeNativeElement as HTMLElement;

    expect(element.querySelector('h1')?.textContent).toBe('Retrieval Playground');
    expect(element.textContent).not.toContain('Planned');
    expect(document.title).toBe('Retrieval Playground · RAGLab');
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/collections').flush({ items: [collection({ id: OTHER_ID })] });
    http.match('/api/system/info');
    const search = http.expectOne('/api/playground/search');
    expect(search.request.body).toEqual({ collectionId: OTHER_ID, query: 'reindex', topK: 3 });
  });

  it('/chat is the chat page (not a placeholder) and reads ?collection=', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(`/chat?collection=${OTHER_ID}`);
    const element = harness.routeNativeElement as HTMLElement;

    expect(element.querySelector('h1')?.textContent).toBe('Chat');
    expect(element.textContent).not.toContain('Planned');
    expect(document.title).toBe('Chat · RAGLab');
    TestBed.inject(HttpTestingController)
      .expectOne('/api/collections')
      .flush({
        items: [collection({ id: COLLECTION_ID }), collection({ id: OTHER_ID, name: 'Other' })],
      });
    await harness.fixture.whenStable();
    expect(element.querySelector('select')?.value).toBe(OTHER_ID);
  });

  it.each([
    ['/knowledge-bases', 'Knowledge Bases', 'Knowledge Bases · RAGLab'],
    [`/knowledge-bases/${COLLECTION_ID}`, 'Knowledge base', 'Knowledge Base · RAGLab'],
    [`/knowledge-bases/${COLLECTION_ID}/documents/${DOCUMENT_ID}`, 'Document', 'Document · RAGLab'],
  ])('%s is a knowledge-base page (breadcrumb/heading "%s")', async (url, label, title) => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    const element = harness.routeNativeElement as HTMLElement;

    expect(element.textContent).toContain(label);
    expect(element.textContent).not.toContain('Planned');
    expect(document.title).toBe(title);
    // The pages request their data; nothing is answered in this routing test.
    TestBed.inject(HttpTestingController).match(() => true);
  });

  it('shows a not-found page for unknown URLs', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/does-not-exist');

    expect((harness.routeNativeElement as HTMLElement).querySelector('h1')?.textContent).toBe(
      'Page not found',
    );
  });
});
