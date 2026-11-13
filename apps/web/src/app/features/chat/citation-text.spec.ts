import { TestBed } from '@angular/core/testing';
import { chatSource } from '../../../testing/fixtures';
import { CitationText } from './citation-text';

describe('CitationText', () => {
  it('labels citation buttons with path:lines of the source', async () => {
    const fixture = TestBed.createComponent(CitationText);
    fixture.componentRef.setInput('text', 'See [1] and [2].');
    fixture.componentRef.setInput('sources', [
      chatSource(1, { path: 'src/tree.ts', startLine: 3, endLine: 9 }),
      chatSource(2),
    ]);
    await fixture.whenStable();

    const buttons = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'));
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Source 1: src/tree.ts:3–9',
      'Source 2: guide-2.md',
    ]);
  });
});
