import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from './app.routes';

describe('routes', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter(routes), provideHttpClient(), provideHttpClientTesting()],
    });
  });

  it.each([
    ['/knowledge-bases', 'Knowledge Bases', 'prompts/009-angular-knowledge-ui.md'],
    ['/chat', 'Chat', 'prompts/010-angular-chat-ui.md'],
    ['/playground', 'Retrieval Playground', 'prompts/011-retrieval-playground.md'],
  ])('%s is marked as planned and names its prompt', async (url, heading, prompt) => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    const element = harness.routeNativeElement as HTMLElement;

    expect(element.querySelector('h1')?.textContent).toBe(heading);
    expect(element.textContent).toContain('Planned');
    expect(element.textContent).toContain(prompt);
  });

  it('shows a not-found page for unknown URLs', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/does-not-exist');

    expect((harness.routeNativeElement as HTMLElement).querySelector('h1')?.textContent).toBe(
      'Page not found',
    );
  });
});
