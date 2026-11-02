import {
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  effect,
  input,
  output,
  untracked,
  viewChild,
} from '@angular/core';

/**
 * Modal confirmation for destructive actions, built on the native `<dialog>`.
 *
 * `showModal()` makes the rest of the page inert, so focus stays inside the dialog (focus trap);
 * Escape cancels. Focus starts on "Cancel" (the safe choice) and returns to the element that was
 * focused before opening. The message is projected content.
 */
@Component({
  selector: 'rl-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dialog
      class="dialog"
      [attr.aria-labelledby]="headingId"
      [attr.aria-describedby]="messageId"
      (cancel)="onEscape($event)"
    >
      <h2 [id]="headingId">{{ heading() }}</h2>
      <div [id]="messageId" class="dialog__message"><ng-content /></div>
      @if (error(); as message) {
        <p class="rl-alert" role="alert"><span aria-hidden="true">✕</span> {{ message }}</p>
      }
      <div class="rl-actions dialog__actions">
        <button #cancelButton type="button" class="rl-btn" [disabled]="busy()" (click)="cancel()">
          Cancel
        </button>
        <button
          type="button"
          class="rl-btn rl-btn--danger"
          [disabled]="busy()"
          (click)="confirmed.emit()"
        >
          {{ busy() ? busyLabel() : confirmLabel() }}
        </button>
      </div>
    </dialog>
  `,
  styles: `
    .dialog {
      max-width: min(32rem, calc(100vw - 2rem));
      border: 1px solid var(--rl-border);
      border-radius: var(--rl-radius);
      background: var(--rl-surface);
      color: var(--rl-text);
      padding: 1.25rem 1.5rem;
    }
    .dialog::backdrop {
      background: rgb(0 0 0 / 50%);
    }
    .dialog__message {
      margin-bottom: 1rem;
      overflow-wrap: anywhere;
    }
    .dialog__actions {
      justify-content: flex-end;
    }
  `,
})
export class ConfirmDialog {
  private static nextId = 0;

  readonly open = input(false);
  readonly heading = input.required<string>();
  readonly confirmLabel = input('Delete');
  readonly busyLabel = input('Deleting…');
  readonly busy = input(false);
  /** Error of the last confirmation attempt, shown inside the dialog. */
  readonly error = input<string | undefined>(undefined);

  readonly confirmed = output();
  readonly cancelled = output();

  protected readonly headingId = `rl-confirm-heading-${ConfirmDialog.nextId}`;
  protected readonly messageId = `rl-confirm-message-${ConfirmDialog.nextId++}`;

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly cancelButton = viewChild.required<ElementRef<HTMLButtonElement>>('cancelButton');
  private returnFocusTo: HTMLElement | null = null;

  constructor() {
    effect(() => {
      const open = this.open();
      const dialog = this.dialog().nativeElement;
      untracked(() => (open ? this.show(dialog) : this.hide(dialog)));
    });
  }

  protected cancel(): void {
    if (!this.busy()) {
      this.cancelled.emit();
    }
  }

  /** Escape: the parent decides via `open`, the dialog never closes on its own. */
  protected onEscape(event: Event): void {
    event.preventDefault();
    this.cancel();
  }

  private show(dialog: HTMLDialogElement): void {
    if (dialog.hasAttribute('open')) {
      return;
    }
    const active = dialog.ownerDocument.activeElement;
    this.returnFocusTo = active instanceof HTMLElement ? active : null;
    // jsdom (unit tests) has no showModal(); browsers always do.
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    this.cancelButton().nativeElement.focus();
  }

  private hide(dialog: HTMLDialogElement): void {
    if (!dialog.hasAttribute('open')) {
      return;
    }
    if (typeof dialog.close === 'function') {
      dialog.close();
    } else {
      dialog.removeAttribute('open');
    }
    const target = this.returnFocusTo;
    this.returnFocusTo = null;
    if (target?.isConnected) {
      target.focus();
    }
  }
}
