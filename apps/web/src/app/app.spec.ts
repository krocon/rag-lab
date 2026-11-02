import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';

describe('App shell', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  async function render(): Promise<HTMLElement> {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('renders the main navigation with all sections', async () => {
    const element = await render();

    const nav = element.querySelector('nav[aria-label="Main"]');
    const links = Array.from(nav?.querySelectorAll('a') ?? []).map((a) => ({
      text: a.textContent?.trim(),
      href: a.getAttribute('href'),
    }));

    expect(links).toEqual([
      { text: expect.stringContaining('Knowledge Bases'), href: '/knowledge-bases' },
      { text: expect.stringContaining('Chat'), href: '/chat' },
      { text: expect.stringContaining('Retrieval Playground'), href: '/playground' },
      { text: expect.stringContaining('Settings'), href: '/settings' },
    ]);
  });

  it('offers a skip link to the main content', async () => {
    const element = await render();

    const skipLink = element.querySelector('a.skip-link');
    expect(skipLink?.getAttribute('href')).toBe('#main-content');
    expect(element.querySelector('main#main-content')).not.toBeNull();
  });
});
