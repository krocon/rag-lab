import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { ChatSource } from '@raglab/shared';
import { formatSourceLocation } from '../../core/util/source-location';
import { segmentAnswer } from './citations';

/**
 * Answer text with clickable citations. Text is interpolated (never `innerHTML`), so HTML in model
 * output shows up as text. Only numbers of delivered sources become buttons; others are marked
 * "unknown source" and are not linked.
 */
@Component({
  selector: 'rl-citation-text',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (segment of segments(); track $index) {
      @if (segment.type === 'text') {
        <span class="text">{{ segment.text }}</span>
      } @else {
        <span class="citation"
          ><span>[</span>
          @for (ref of segment.refs; track $index) {
            @if (!$first) {
              <span>, </span>
            }
            @if (ref.known) {
              <button
                type="button"
                class="citation__ref"
                [attr.aria-label]="label(ref.n)"
                [attr.data-cite]="ref.n"
                [textContent]="ref.n"
                (click)="cite.emit(ref.n)"
              ></button>
            } @else {
              <span class="citation__unknown" [attr.data-unknown-cite]="ref.n"
                ><span aria-hidden="true">⚠ </span>{{ ref.n
                }}<span class="citation__unknown-label"> (unknown source)</span></span
              >
            }
          }
          <span>]</span></span
        >
      }
    }
  `,
  styles: `
    :host {
      overflow-wrap: anywhere;
    }
    .text {
      white-space: pre-wrap;
    }
    .citation {
      white-space: nowrap;
    }
    .citation__ref {
      font: inherit;
      font-size: 0.85em;
      font-weight: 600;
      line-height: 1.2;
      min-width: 1.6em;
      min-height: 1.5em;
      margin: 0 0.05em;
      padding: 0 0.3em;
      border: 1px solid var(--rl-accent);
      border-radius: 4px;
      background: var(--rl-accent-soft);
      color: var(--rl-accent);
      cursor: pointer;
      text-decoration: underline;
    }
    .citation__ref:hover {
      background: var(--rl-accent);
      color: var(--rl-accent-contrast);
    }
    .citation__unknown {
      font-size: 0.85em;
      padding: 0 0.3em;
      border: 1px dashed var(--rl-warn);
      border-radius: 4px;
      background: var(--rl-warn-soft);
      color: var(--rl-warn);
    }
    .citation__unknown-label {
      font-style: italic;
    }
  `,
})
export class CitationText {
  readonly text = input.required<string>();
  readonly sources = input<readonly ChatSource[]>([]);
  /** Emits the number of the clicked (delivered) source. */
  readonly cite = output<number>();

  private readonly byNumber = computed(
    () => new Map(this.sources().map((source) => [source.n, source])),
  );
  protected readonly segments = computed(() =>
    segmentAnswer(this.text(), new Set(this.byNumber().keys())),
  );

  protected label(n: number): string {
    const source = this.byNumber().get(n);
    return source ? `Source ${n}: ${formatSourceLocation(source)}` : `Source ${n}`;
  }
}
