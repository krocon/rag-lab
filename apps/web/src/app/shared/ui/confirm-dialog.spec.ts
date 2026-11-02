import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ConfirmDialog } from './confirm-dialog';

@Component({
  imports: [ConfirmDialog],
  template: `
    <button type="button" id="trigger" (click)="open.set(true)">Delete it</button>
    <rl-confirm-dialog
      heading="Delete thing?"
      [open]="open()"
      [busy]="busy()"
      [error]="error()"
      (confirmed)="confirmed = confirmed + 1"
      (cancelled)="open.set(false)"
    >
      <p>This deletes 3 documents.</p>
    </rl-confirm-dialog>
  `,
})
class Host {
  readonly open = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | undefined>(undefined);
  confirmed = 0;
}

describe('ConfirmDialog', () => {
  let fixture: ComponentFixture<Host>;
  let element: HTMLElement;

  beforeEach(async () => {
    fixture = TestBed.createComponent(Host);
    element = fixture.nativeElement as HTMLElement;
    document.body.appendChild(element);
    await fixture.whenStable();
  });

  afterEach(() => element.remove());

  const dialog = () => element.querySelector('dialog') as HTMLDialogElement;
  const button = (name: string) =>
    Array.from(dialog().querySelectorAll('button')).find((b) => b.textContent?.trim() === name);

  async function openFromTrigger(): Promise<void> {
    const trigger = element.querySelector<HTMLButtonElement>('#trigger');
    trigger?.focus();
    trigger?.click();
    await fixture.whenStable();
  }

  it('is closed until opened and is labelled by its heading and message', async () => {
    expect(dialog().hasAttribute('open')).toBe(false);
    await openFromTrigger();

    expect(dialog().hasAttribute('open')).toBe(true);
    const labelledBy = dialog().getAttribute('aria-labelledby') ?? '';
    const describedBy = dialog().getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(labelledBy)?.textContent).toBe('Delete thing?');
    expect(document.getElementById(describedBy)?.textContent).toContain('3 documents');
  });

  it('focuses Cancel when opened and returns focus to the trigger when cancelled', async () => {
    await openFromTrigger();
    expect(document.activeElement).toBe(button('Cancel'));

    button('Cancel')?.click();
    await fixture.whenStable();

    expect(dialog().hasAttribute('open')).toBe(false);
    expect(document.activeElement?.id).toBe('trigger');
  });

  it('cancels on Escape (cancel event) instead of closing itself', async () => {
    await openFromTrigger();
    const event = new Event('cancel', { cancelable: true });
    dialog().dispatchEvent(event);
    await fixture.whenStable();

    expect(event.defaultPrevented).toBe(true);
    expect(fixture.componentInstance.open()).toBe(false);
  });

  it('emits confirmed, disables buttons while busy and shows errors', async () => {
    await openFromTrigger();
    button('Delete')?.click();
    expect(fixture.componentInstance.confirmed).toBe(1);

    fixture.componentInstance.busy.set(true);
    fixture.componentInstance.error.set('Server said no');
    await fixture.whenStable();

    expect(button('Cancel')?.disabled).toBe(true);
    expect(button('Deleting…')?.disabled).toBe(true);
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('Server said no');
  });
});
