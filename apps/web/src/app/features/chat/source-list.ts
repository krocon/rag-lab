import { ChangeDetectionStrategy, Component, ElementRef, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ChatSource } from '@raglab/shared';
import { formatSourceLocation, isCodeLanguage } from '../../core/util/source-location';
import { ExternalLink } from '../../shared/ui/external-link';

/** Characters of a chunk shown before "Show full passage". */
export const SNIPPET_CHARS = 280;

/**
 * The sources an answer was given, numbered like the citations `[n]`: `path:lines` (file name as
 * fallback), language, symbol or heading path, score, excerpt, a deep link to the chunk in the
 * document view and – for repository imports – a link to the lines at the imported commit.
 * All content is rendered as text.
 */
@Component({
  selector: 'rl-source-list',
  imports: [RouterLink, ExternalLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="sources" [attr.aria-labelledby]="headingId()">
      <h3 [id]="headingId()">Sources ({{ sources().length }})</h3>
      <p class="rl-muted explain">
        <strong>score</strong> = cosine similarity between question and passage (1 − distance, from
        −1 to 1, higher = more similar). It ranks passages; it is not a confidence in the answer.
      </p>
      <ol class="list">
        @for (source of sources(); track source.chunkId) {
          @let selected = source.n === highlighted();
          @let isCited = cited()?.includes(source.n) ?? false;
          <li
            class="source"
            tabindex="-1"
            [attr.data-source]="source.n"
            [attr.aria-labelledby]="headingId() + '-' + source.n"
            [attr.aria-current]="selected ? 'true' : null"
            [class.is-selected]="selected"
          >
            <div class="source__header">
              <h4 [id]="headingId() + '-' + source.n">
                <span class="source__n">[{{ source.n }}]</span> {{ location(source) }}
              </h4>
              @if (selected) {
                <span class="rl-badge rl-badge--info"
                  ><span aria-hidden="true">➜</span> Selected</span
                >
              }
              @if (cited() !== null) {
                @if (isCited) {
                  <span class="rl-badge rl-badge--ok"><span aria-hidden="true">✓</span> Cited</span>
                } @else {
                  <span class="rl-badge rl-badge--neutral"
                    ><span aria-hidden="true">–</span> Not cited</span
                  >
                }
              }
            </div>
            <dl class="rl-dl meta">
              <dt>Language</dt>
              <dd>{{ source.language }}</dd>
              @if (source.symbol) {
                <dt>Symbol</dt>
                <dd>
                  <code>{{ source.symbol }}</code>
                </dd>
              } @else if (source.headingPath.length > 0 && !isCode(source.language)) {
                <dt>Section</dt>
                <dd>{{ source.headingPath.join(' › ') }}</dd>
              }
              <dt>score</dt>
              <dd>
                {{ source.score.toFixed(3) }}
                <span class="rl-muted">(distance {{ source.distance.toFixed(3) }})</span>
              </dd>
              <dt>Chunk</dt>
              <dd>#{{ source.chunkIndex }}</dd>
            </dl>
            @if (source.content.length > snippetChars) {
              <p class="excerpt">{{ snippet(source.content) }}</p>
              <details>
                <summary>Show full passage</summary>
                <p class="excerpt">{{ source.content }}</p>
              </details>
            } @else {
              <p class="excerpt">{{ source.content }}</p>
            }
            <a
              class="open"
              [routerLink]="['/knowledge-bases', collectionId(), 'documents', source.documentId]"
              [queryParams]="{ chunk: source.chunkId }"
              [attr.aria-label]="'Open source ' + source.n + ' in ' + source.filename"
              >Open in document <span aria-hidden="true">→</span></a
            >
            @if (source.sourceUrl) {
              <span class="external"><rl-external-link [url]="source.sourceUrl" /></span>
            }
          </li>
        }
      </ol>
    </section>
  `,
  styles: `
    h3 {
      font-size: 1rem;
      margin: 0 0 0.25rem;
    }
    .explain {
      font-size: 0.85rem;
    }
    .list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 0.6rem;
    }
    .source {
      border: 1px solid var(--rl-border);
      border-radius: 6px;
      padding: 0.75rem;
      background: var(--rl-surface);
      scroll-margin: 1rem;
    }
    .source.is-selected {
      border: 2px solid var(--rl-accent);
      box-shadow: 0 0 0 3px var(--rl-accent-soft);
    }
    .source__header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.4rem;
    }
    h4 {
      margin: 0;
      font-size: 0.95rem;
      overflow-wrap: anywhere;
    }
    .source__n {
      font-family: var(--rl-mono);
      color: var(--rl-accent);
    }
    .meta {
      font-size: 0.85rem;
      margin-bottom: 0.5rem;
    }
    .excerpt {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 0.9rem;
      padding: 0.5rem;
      background: var(--rl-surface-muted);
      border-radius: 6px;
      margin: 0 0 0.5rem;
    }
    details {
      margin-bottom: 0.5rem;
      font-size: 0.9rem;
    }
    summary {
      cursor: pointer;
      margin-bottom: 0.4rem;
    }
    .open,
    .external {
      font-size: 0.9rem;
    }
    .external {
      margin-left: 1rem;
    }
  `,
})
export class SourceList {
  readonly sources = input.required<readonly ChatSource[]>();
  /** Knowledge base of the answer (for the document link). */
  readonly collectionId = input.required<string>();
  /** `done.citedSources`; `null` while the answer is not complete. */
  readonly cited = input<readonly number[] | null>(null);
  /** Source selected via a citation. */
  readonly highlighted = input<number | null>(null);
  /** Unique id prefix for headings. */
  readonly headingId = input.required<string>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly snippetChars = SNIPPET_CHARS;
  protected readonly location = formatSourceLocation;
  protected readonly isCode = isCodeLanguage;

  protected snippet(content: string): string {
    return `${content.slice(0, SNIPPET_CHARS).trimEnd()}…`;
  }

  /** Scrolls to source `n` and moves the keyboard focus there. */
  reveal(n: number): void {
    const element = Array.from(
      this.host.nativeElement.querySelectorAll<HTMLElement>('[data-source]'),
    ).find((candidate) => candidate.dataset['source'] === String(n));
    if (!element) {
      return;
    }
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    element.scrollIntoView?.({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
    element.focus({ preventScroll: true });
  }
}
