import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { ChatSource } from '@raglab/shared';
import { COLLECTION_ID, chatSource, required, text } from '../../../testing/fixtures';
import { SourceList } from './source-list';

describe('SourceList', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
  });

  async function render(sources: ChatSource[]): Promise<HTMLElement> {
    const fixture = TestBed.createComponent(SourceList);
    fixture.componentRef.setInput('sources', sources);
    fixture.componentRef.setInput('collectionId', COLLECTION_ID);
    fixture.componentRef.setInput('headingId', 'src');
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  const codeSource = (overrides: Partial<ChatSource> = {}) =>
    chatSource(1, {
      filename: 'tree.ts',
      path: 'packages/table/src/tree.ts',
      language: 'typescript',
      headingPath: ['packages/table/src/tree.ts', 'class TreeFactory'],
      startLine: 10,
      endLine: 42,
      symbol: 'class TreeFactory',
      sourceUrl: 'https://github.com/o/r/blob/abc123/packages/table/src/tree.ts#L10-L42',
      ...overrides,
    });

  it('shows path:lines, language and symbol of a code source', async () => {
    const element = await render([codeSource()]);
    const card = required(element.querySelector('[data-source="1"]'));
    expect(text(card.querySelector('h4'))).toBe('[1] packages/table/src/tree.ts:10–42');
    const meta = Array.from(card.querySelectorAll('dt')).map((dt) => [
      text(dt),
      text(dt.nextElementSibling),
    ]);
    expect(meta.slice(0, 2)).toEqual([
      ['Language', 'typescript'],
      ['Symbol', 'class TreeFactory'],
    ]);
    expect(meta.map(([dt]) => dt)).not.toContain('Section');
  });

  it('links to the lines in the repository in a new tab', async () => {
    const element = await render([codeSource()]);
    const links = Array.from(element.querySelectorAll('a'));
    const external = required(links.find((a) => a.getAttribute('target') === '_blank'));
    expect(external.getAttribute('href')).toBe(
      'https://github.com/o/r/blob/abc123/packages/table/src/tree.ts#L10-L42',
    );
    expect(external.getAttribute('rel')).toBe('noopener noreferrer');
    expect(text(external)).toContain('View on github.com');
  });

  it.each([null, 'http://github.com/o/r', 'javascript:alert(1)'])(
    'renders no external link for sourceUrl %s',
    async (sourceUrl) => {
      const element = await render([codeSource({ sourceUrl })]);
      expect(element.querySelector('a[target="_blank"]')).toBeNull();
      // The internal document link stays.
      expect(element.querySelectorAll('a')).toHaveLength(1);
    },
  );

  it('falls back to the file name for uploads without path and lines', async () => {
    const element = await render([chatSource(2)]);
    expect(text(element.querySelector('h4'))).toBe('[2] guide-2.md');
  });
});
