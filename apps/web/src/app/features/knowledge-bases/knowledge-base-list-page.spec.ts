import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { COLLECTION_ID, apiError, collection, text, required } from '../../../testing/fixtures';
import { KnowledgeBaseListPage } from './knowledge-base-list-page';

describe('KnowledgeBaseListPage', () => {
  let fixture: ComponentFixture<KnowledgeBaseListPage>;
  let http: HttpTestingController;
  let element: HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(KnowledgeBaseListPage);
    element = fixture.nativeElement as HTMLElement;
    document.body.appendChild(element);
    // Not whenStable(): it would wait for the pending HTTP request that each test flushes.
    TestBed.tick();
  });

  afterEach(() => {
    element.remove();
    http.verify();
  });

  /** Lets the awaited request promise of the page continue, then renders. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
  }

  const buttonByName = (name: string) =>
    Array.from(element.querySelectorAll('button')).find((b) => text(b).includes(name));

  it('shows a loading state, then the collections with counts', async () => {
    expect(text(element.querySelector('[role="status"]'))).toBe('Loading knowledge bases…');

    http.expectOne('/api/collections').flush({ items: [collection()] });
    await fixture.whenStable();

    const list = element.querySelector('ul[aria-label="Knowledge bases"]');
    const link = list?.querySelector('a');
    expect(text(link)).toBe('Project docs');
    expect(link?.getAttribute('href')).toBe(`/knowledge-bases/${COLLECTION_ID}`);
    expect(text(list)).toContain('2 documents');
    expect(text(list)).toContain('(1 ready)');
    expect(text(list)).toContain('12 chunks');
    expect(text(list)).toContain('example-embed (768 dimensions)');
  });

  it('shows an empty state with a call to action that opens the form', async () => {
    http.expectOne('/api/collections').flush({ items: [] });
    await fixture.whenStable();

    expect(text(element.querySelector('h2'))).toBe('No knowledge bases yet');
    buttonByName('Create your first knowledge base')?.click();
    await fixture.whenStable();

    expect(element.querySelector('form')).not.toBeNull();
    expect(document.activeElement).toBe(element.querySelector('input[name="name"]'));
  });

  it('shows an error with retry when loading fails', async () => {
    http
      .expectOne('/api/collections')
      .flush(apiError('INTERNAL_ERROR', 'Database down'), { status: 500, statusText: 'Error' });
    await fixture.whenStable();

    const alert = element.querySelector('[role="alert"]');
    expect(text(alert)).toContain('could not be loaded. Database down');
    alert?.querySelector('button')?.click();
    TestBed.tick();
    http.expectOne('/api/collections').flush({ items: [] });
  });

  it('creates a collection and opens it', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    http.expectOne('/api/collections').flush({ items: [collection()] });
    await fixture.whenStable();
    buttonByName('New knowledge base')?.click();
    await fixture.whenStable();

    const input = required(element.querySelector<HTMLInputElement>('input[name="name"]'));
    input.value = 'Handbook';
    input.dispatchEvent(new Event('input'));
    element.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    TestBed.tick();

    const request = http.expectOne({ method: 'POST', url: '/api/collections' });
    expect(request.request.body).toEqual({ name: 'Handbook' });
    request.flush(collection({ name: 'Handbook' }), { status: 201, statusText: 'Created' });
    await settle();

    expect(navigate).toHaveBeenCalledWith(['/knowledge-bases', COLLECTION_ID]);
  });

  it('shows a 409 at the name field', async () => {
    http.expectOne('/api/collections').flush({ items: [collection()] });
    await fixture.whenStable();
    buttonByName('New knowledge base')?.click();
    await fixture.whenStable();

    const input = required(element.querySelector<HTMLInputElement>('input[name="name"]'));
    input.value = 'project docs';
    input.dispatchEvent(new Event('input'));
    element.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    TestBed.tick();
    http.expectOne({ method: 'POST', url: '/api/collections' }).flush(
      apiError('COLLECTION_NAME_TAKEN', 'A collection named "project docs" already exists', {
        name: 'project docs',
      }),
      { status: 409, statusText: 'Conflict' },
    );
    await settle();

    expect(input.getAttribute('aria-invalid')).toBe('true');
    const errorId = (input.getAttribute('aria-describedby') ?? '').split(' ')[1];
    expect(text(element.querySelector(`#${errorId}`))).toContain(
      'A knowledge base named "project docs" already exists',
    );
  });
});
