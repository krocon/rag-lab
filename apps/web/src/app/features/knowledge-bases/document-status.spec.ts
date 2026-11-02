import { TestBed } from '@angular/core/testing';
import type { DocumentStatus } from '@raglab/shared';
import { DocumentStatusBadge, isActiveStatus } from './document-status';

describe('DocumentStatusBadge', () => {
  it.each<[DocumentStatus, string, string]>([
    ['pending', '◷', 'Pending'],
    ['processing', '⟳', 'Processing'],
    ['ready', '✓', 'Ready'],
    ['failed', '✕', 'Failed'],
  ])('shows %s as icon and text, not color alone', async (status, icon, label) => {
    const fixture = TestBed.createComponent(DocumentStatusBadge);
    fixture.componentRef.setInput('status', status);
    await fixture.whenStable();

    const badge = (fixture.nativeElement as HTMLElement).querySelector('.rl-badge');
    expect(badge?.textContent).toContain(label);
    const iconElement = badge?.querySelector('[aria-hidden="true"]');
    expect(iconElement?.textContent).toBe(icon);
  });

  it('treats pending and processing as active', () => {
    expect(isActiveStatus('pending')).toBe(true);
    expect(isActiveStatus('processing')).toBe(true);
    expect(isActiveStatus('ready')).toBe(false);
    expect(isActiveStatus('failed')).toBe(false);
  });
});
