import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { PlaygroundResult } from '@raglab/shared';
import { COLLECTION_ID, playgroundResult, required, text } from '../../../testing/fixtures';
import { PlaygroundResults } from './playground-results';

const SOURCE_URL = 'https://github.com/o/r/blob/abc123/packages/table/src/tree.ts#L10-L42';
const HEADER = 'File: packages/table/src/tree.ts\nSymbol: class TreeFactory\n\n';

function codeResult(overrides: Partial<PlaygroundResult> = {}): PlaygroundResult {
  return playgroundResult(1, {
    filename: 'tree.ts',
    path: 'packages/table/src/tree.ts',
    language: 'typescript',
    headingPath: ['packages/table/src/tree.ts', 'class TreeFactory'],
    content: 'export class TreeFactory {\n  // <b>x</b>\n}',
    startLine: 10,
    endLine: 42,
    symbol: 'class TreeFactory',
    sourceUrl: SOURCE_URL,
    embeddingHeader: HEADER,
    ...overrides,
  });
}

describe('PlaygroundResults', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
  });

  async function render(results: PlaygroundResult[]): Promise<HTMLElement> {
    const fixture = TestBed.createComponent(PlaygroundResults);
    fixture.componentRef.setInput('results', results);
    fixture.componentRef.setInput('collectionId', COLLECTION_ID);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  async function expand(element: HTMLElement): Promise<HTMLElement> {
    const toggle = required(
      Array.from(element.querySelectorAll('button')).find((b) => text(b) === 'Show'),
    );
    toggle.click();
    TestBed.tick();
    return required(element.querySelector<HTMLElement>(`#${toggle.getAttribute('aria-controls')}`));
  }

  it('shows path:lines, language and symbol in the source column', async () => {
    const element = await render([codeResult()]);
    const source = required(element.querySelector('tbody th'));
    expect(text(source.querySelector('.source__file'))).toBe('packages/table/src/tree.ts:10–42');
    expect(text(source.querySelector('.source__path'))).toBe('typescript · class TreeFactory');
  });

  it('falls back to the file name and heading path for prose without lines', async () => {
    const element = await render([playgroundResult(2)]);
    const source = required(element.querySelector('tbody th'));
    expect(text(source.querySelector('.source__file'))).toBe('guide-2.md');
    expect(text(source.querySelector('.source__path'))).toBe('markdown · Guide › Part 2');
  });

  it('shows the embedded header labelled above the chunk text, as text', async () => {
    const element = await render([codeResult()]);
    const detail = await expand(element);

    const header = required(detail.querySelector('[data-testid="embedding-header"]'));
    expect(header.textContent).toBe(HEADER);
    const label = required(detail.querySelector(`#${header.getAttribute('aria-labelledby')}`));
    expect(text(label)).toContain('Embedded header');
    const excerpts = Array.from(detail.querySelectorAll('.excerpt'));
    expect(excerpts.map((e) => e.textContent).join('')).toBe(HEADER + codeResult().content);
    expect(detail.querySelector('b')).toBeNull();
  });

  it('links to the repository lines in a new tab', async () => {
    const element = await render([codeResult()]);
    const detail = await expand(element);
    const external = required(detail.querySelector('a[target="_blank"]'));
    expect(external.getAttribute('href')).toBe(SOURCE_URL);
    expect(external.getAttribute('rel')).toBe('noopener noreferrer');
    expect(text(external)).toContain('View on github.com');
  });

  it('shows neither header nor external link when they are absent or unsafe', async () => {
    const element = await render([
      codeResult({ embeddingHeader: null, sourceUrl: 'javascript:alert(1)' }),
    ]);
    const detail = await expand(element);
    expect(detail.querySelector('[data-testid="embedding-header"]')).toBeNull();
    expect(text(detail)).not.toContain('Embedded header');
    expect(detail.querySelector('a[target="_blank"]')).toBeNull();
  });
});
