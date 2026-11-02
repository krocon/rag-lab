import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  InjectionToken,
  inject,
  input,
  signal,
} from '@angular/core';
import type { PlaygroundPromptPreview } from '@raglab/shared';

/** Writes text to the clipboard; replaceable in tests. */
export const CLIPBOARD_WRITE = new InjectionToken<(text: string) => Promise<void>>(
  'CLIPBOARD_WRITE',
  {
    providedIn: 'root',
    factory: () => {
      const navigator = inject(DOCUMENT).defaultView?.navigator;
      return (text: string) =>
        navigator?.clipboard
          ? navigator.clipboard.writeText(text)
          : Promise.reject(new Error('Clipboard not available'));
    },
  },
);

/** All messages as one text, e.g. to paste into another tool. */
export function promptAsText(prompt: PlaygroundPromptPreview): string {
  return prompt.messages.map((message) => `### ${message.role}\n\n${message.content}`).join('\n\n');
}

/**
 * The messages chat would send to the model for this query (system rules, numbered `<source>`
 * blocks, question) – shown as plain text and copyable. Built by the API without calling a model.
 */
@Component({
  selector: 'rl-prompt-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let p = prompt();
    <section class="rl-card" aria-labelledby="pg-prompt-heading">
      <div class="head">
        <h2 id="pg-prompt-heading">Prompt preview</h2>
        <button type="button" class="rl-btn rl-btn--small" (click)="copy(all(), 'Prompt')">
          <span aria-hidden="true">⧉</span> Copy prompt
        </button>
      </div>
      <p class="rl-muted">
        Exactly what the chat would send to <code>{{ p.chatModel.model }}</code> ({{
          p.chatModel.provider
        }}) for this query. Built without calling the model. Source content is untrusted data.
      </p>
      @if (!p.wouldCallModel) {
        <div class="rl-alert rl-alert--warn" role="note">
          <p>
            <span aria-hidden="true">⚠</span> No source fits, so the chat would
            <strong>not</strong> call the model and answer with this fixed text instead:
          </p>
          <p>
            <q>{{ p.noSourcesAnswer }}</q>
          </p>
        </div>
      }
      @for (message of p.messages; track $index) {
        <div class="message">
          <div class="head">
            <h3 [id]="'pg-prompt-' + $index">{{ label(message.role) }}</h3>
            <button
              type="button"
              class="rl-btn rl-btn--small"
              [attr.aria-label]="'Copy ' + label(message.role).toLowerCase()"
              (click)="copy(message.content, label(message.role))"
            >
              <span aria-hidden="true">⧉</span> Copy
            </button>
          </div>
          <pre tabindex="0" [attr.aria-labelledby]="'pg-prompt-' + $index">{{
            message.content
          }}</pre>
        </div>
      }
      <p class="rl-muted copy-status" role="status" aria-live="polite">{{ status() }}</p>
    </section>
  `,
  styles: `
    .head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.75rem;
      flex-wrap: wrap;
    }
    h3 {
      font-size: 0.95rem;
      margin: 0;
    }
    .message {
      margin-top: 1rem;
    }
    .copy-status {
      margin: 0.75rem 0 0;
      min-height: 1.5em;
    }
    pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 0.85rem;
      background: var(--rl-surface-muted);
      border: 1px solid var(--rl-border);
      border-radius: 6px;
      padding: 0.75rem;
      margin: 0.4rem 0 0;
      max-height: 28rem;
      overflow: auto;
    }
  `,
})
export class PromptPreview {
  readonly prompt = input.required<PlaygroundPromptPreview>();

  private readonly write = inject(CLIPBOARD_WRITE);
  protected readonly status = signal('');

  protected all(): string {
    return promptAsText(this.prompt());
  }

  protected label(role: string): string {
    return role === 'system' ? 'System message' : role === 'user' ? 'User message' : 'Assistant';
  }

  protected async copy(text: string, what: string): Promise<void> {
    try {
      await this.write(text);
      this.status.set(`${what} copied to the clipboard.`);
    } catch {
      this.status.set(`${what} could not be copied. Select the text and copy it manually.`);
    }
  }
}
