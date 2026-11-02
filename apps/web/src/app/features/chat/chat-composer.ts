import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  afterRenderEffect,
  inject,
  type ElementRef,
  computed,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

/**
 * Question input. `Enter` sends, `Shift+Enter` adds a line. The field stays editable while an
 * answer streams (the next question can be drafted); when the Cancel button disappears with focus
 * on it, the focus moves back to the field instead of getting lost.
 */
@Component({
  selector: 'rl-chat-composer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="composer" (submit)="$event.preventDefault(); submit()">
      <div class="rl-field">
        <label for="chat-question">Question</label>
        <textarea
          #field
          id="chat-question"
          name="question"
          rows="2"
          aria-describedby="chat-question-hint"
          [attr.aria-disabled]="unavailable() ? 'true' : null"
          [value]="question()"
          (input)="question.set(field.value)"
          (keydown)="onKeydown($event)"
        ></textarea>
        <p id="chat-question-hint" class="rl-field__hint">
          @if (unavailable(); as reason) {
            {{ reason }}
          } @else {
            <kbd>Enter</kbd> sends · <kbd>Shift</kbd>+<kbd>Enter</kbd> adds a line ·
            <kbd>Esc</kbd> cancels a running answer
          }
        </p>
      </div>
      <div class="rl-actions">
        @if (busy()) {
          <button type="button" class="rl-btn rl-btn--danger" (click)="cancelled.emit(); focus()">
            <span aria-hidden="true">■</span> Cancel answer
          </button>
        }
        <button type="submit" class="rl-btn rl-btn--primary" [disabled]="!canSend()">
          <span aria-hidden="true">➤</span> Send
        </button>
      </div>
    </form>
  `,
  styles: `
    .composer .rl-field {
      margin-bottom: 0.5rem;
    }
    .composer .rl-actions {
      justify-content: flex-end;
    }
    kbd {
      border: 1px solid var(--rl-border-strong);
      border-radius: 4px;
      padding: 0 0.3em;
      background: var(--rl-surface-muted);
    }
  `,
})
export class ChatComposer {
  /** An answer is streaming: sending waits, `Escape`/Cancel abort it. */
  readonly busy = input(false);
  /** Why no question can be sent right now (e.g. no knowledge base selected); `null` if possible. */
  readonly unavailable = input<string | null>(null);
  readonly send = output<string>();
  readonly cancelled = output();

  protected readonly question = signal('');
  private readonly field = viewChild.required<ElementRef<HTMLTextAreaElement>>('field');

  private readonly document = inject(DOCUMENT);

  constructor() {
    let wasBusy = false;
    afterRenderEffect(() => {
      const busy = this.busy();
      const active = this.document.activeElement;
      if (wasBusy && !busy && (active === null || active === this.document.body)) {
        this.focus();
      }
      wasBusy = busy;
    });
  }

  protected readonly canSend = computed(
    () => !this.busy() && this.unavailable() === null && this.question().trim().length > 0,
  );

  focus(): void {
    this.field().nativeElement.focus();
  }

  /** Replaces the text (e.g. "Edit question") and focuses the field. */
  setQuestion(text: string): void {
    this.question.set(text);
    this.focus();
  }

  protected onKeydown(event: KeyboardEvent): void {
    // `Escape` is handled by the chat page, so it also works outside this field.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      this.submit();
    }
  }

  protected submit(): void {
    if (!this.canSend()) {
      return;
    }
    this.send.emit(this.question().trim());
    this.question.set('');
    // Also clear the element: typing and sending within one render would leave the binding at ''.
    this.field().nativeElement.value = '';
    // Keeps the focus in the field: the send button is disabled while the answer streams.
    this.focus();
  }
}
