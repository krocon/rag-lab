import { TestBed } from '@angular/core/testing';
import { text } from '../../../testing/fixtures';
import { ExternalLink } from './external-link';

describe('ExternalLink', () => {
  async function render(url: string | null, label?: string): Promise<HTMLElement> {
    const fixture = TestBed.createComponent(ExternalLink);
    fixture.componentRef.setInput('url', url);
    if (label !== undefined) {
      fixture.componentRef.setInput('label', label);
    }
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('renders an https link that opens in a new tab without opener and referrer', async () => {
    const url = 'https://github.com/o/r/blob/abc/src/a.ts#L10-L42';
    const element = await render(url);
    const link = element.querySelector('a');
    expect(link?.getAttribute('href')).toBe(url);
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(text(link)).toBe('View on github.com ↗ (opens in a new tab)');
  });

  it('uses a custom label', async () => {
    const element = await render('https://gitlab.com/g/p', 'Repository');
    expect(text(element.querySelector('a'))).toContain('Repository');
  });

  it.each([null, 'http://github.com/o/r', 'javascript:alert(1)', 'https://user:pw@github.com/o/r'])(
    'renders nothing for %s',
    async (url) => {
      const element = await render(url);
      expect(element.querySelector('a')).toBeNull();
    },
  );
});
