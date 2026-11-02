import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { CitationText } from './citation-text';
import type { ChatTurn, TurnError } from './chat.store';
import { SourceList } from './source-list';

const ERROR_TITLES: Record<TurnError['kind'], string> = {
  request: 'The question could not be answered',
  stream: 'The chat model could not generate an answer',
  network: 'The API is not reachable',
  interrupted: 'The connection was interrupted',
};

/** One question with its streamed answer, state, sources and errors. */
@Component({
  selector: 'rl-chat-message',
  imports: [RouterLink, CitationText, SourceList],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let t = turn();
    @let status = t.status();
    @let error = t.error();
    @let done = t.done();
    @let sources = t.sources();
    <article class="turn" [attr.aria-labelledby]="prefix() + '-q'" [attr.data-status]="status">
      <h2 class="turn__label" [id]="prefix() + '-q'">
        Question {{ index() }}
        <span class="rl-muted">· {{ t.collection.name }}</span>
      </h2>
      <p class="question">{{ t.question }}</p>

      <section
        class="answer rl-card"
        [attr.aria-labelledby]="prefix() + '-a'"
        [attr.aria-busy]="t.active()"
      >
        <div class="answer__header">
          <h3 [id]="prefix() + '-a'">Answer</h3>
          @switch (status) {
            @case ('retrieving') {
              <span class="rl-badge rl-badge--info"
                ><span aria-hidden="true">⌕</span> Searching sources…</span
              >
            }
            @case ('streaming') {
              <span class="rl-badge rl-badge--info"
                ><span aria-hidden="true">✎</span> Generating…</span
              >
            }
            @case ('done') {
              @if (t.noSources()) {
                <span class="rl-badge rl-badge--warn"
                  ><span aria-hidden="true">∅</span> No sources found</span
                >
              } @else {
                <span class="rl-badge rl-badge--ok"
                  ><span aria-hidden="true">✓</span> Complete</span
                >
              }
            }
            @case ('aborted') {
              <span class="rl-badge rl-badge--neutral"
                ><span aria-hidden="true">■</span> Cancelled</span
              >
            }
            @case ('error') {
              <span class="rl-badge rl-badge--danger"
                ><span aria-hidden="true">✕</span> Failed</span
              >
            }
          }
        </div>

        @if (status === 'retrieving') {
          <p class="rl-muted">Searching the knowledge base for matching passages…</p>
        } @else if (t.noSources()) {
          <div class="no-sources" data-testid="no-sources">
            <p>
              <strong>No matching sources.</strong> {{ t.answer() }} The question was not sent to
              the chat model.
            </p>
            <ul>
              <li>Check that the knowledge base has documents with status “Ready”.</li>
              <li>Rephrase the question with words that appear in the documents.</li>
            </ul>
            <p>
              <a [routerLink]="['/knowledge-bases', t.collection.id]"
                >Open “{{ t.collection.name }}”</a
              >
            </p>
          </div>
        } @else {
          @if (t.answer().length > 0) {
            <div class="answer__text" data-testid="answer">
              <rl-citation-text
                [text]="t.answer()"
                [sources]="sources ?? []"
                (cite)="select($event)"
              />
              @if (status === 'streaming') {
                <span class="caret" aria-hidden="true"></span>
              }
            </div>
          } @else if (status === 'streaming') {
            <p class="rl-muted">
              Waiting for the chat model… The first answer can take a while when the model is
              loading.
            </p>
          }
          @if (status === 'aborted') {
            <p class="note" data-testid="aborted">
              <span aria-hidden="true">■</span> You cancelled this answer
              @if (t.answer().length > 0) {
                – it is incomplete.
              } @else {
                before the model answered.
              }
            </p>
          }
          @if (done && done.unknownCitations.length > 0) {
            <p class="note note--warn" data-testid="unknown-citations">
              <span aria-hidden="true">⚠</span> The answer cites
              {{ done.unknownCitations.length === 1 ? 'a source' : 'sources' }} that the model was
              not given: {{ bracketed(done.unknownCitations) }}. They are marked as unknown and are
              not linked.
            </p>
          }
          @if (done && done.model) {
            <p class="rl-muted meta">
              Model <code>{{ done.model }}</code> · {{ seconds(done.timings.totalMs) }}
            </p>
          }
        }

        @if (error) {
          <div class="rl-alert" role="alert" [attr.data-error-kind]="error.kind">
            <p>
              <strong><span aria-hidden="true">✕</span> {{ errorTitle(error) }}.</strong>
              {{ error.message }}
            </p>
            @if (error.code === 'COLLECTION_NOT_FOUND') {
              <p>
                Choose another one in the list above, or open
                <a routerLink="/knowledge-bases">Knowledge Bases</a>.
              </p>
            } @else if (error.kind === 'interrupted' && t.answer().length > 0) {
              <p>The text above is incomplete.</p>
            }
            <p class="rl-muted code">
              Error code <code>{{ error.code }}</code>
              @if (error.status > 0) {
                (HTTP {{ error.status }})
              }
            </p>
            <div class="rl-actions">
              @if (error.code === 'VALIDATION_ERROR') {
                <button
                  type="button"
                  class="rl-btn"
                  [disabled]="busy()"
                  (click)="edit.emit(t.question)"
                >
                  Edit question
                </button>
              } @else {
                <button type="button" class="rl-btn" [disabled]="busy()" (click)="onRetry(t)">
                  <span aria-hidden="true">↻</span> Try again
                </button>
              }
            </div>
          </div>
        } @else if (status === 'aborted') {
          <div class="rl-actions">
            <button type="button" class="rl-btn" [disabled]="busy()" (click)="onRetry(t)">
              <span aria-hidden="true">↻</span> Try again
            </button>
          </div>
        }
      </section>

      @if (sources && sources.length > 0) {
        <rl-source-list
          [sources]="sources"
          [collectionId]="t.collection.id"
          [cited]="done ? done.citedSources : null"
          [highlighted]="highlighted()"
          [headingId]="prefix() + '-s'"
        />
      }
    </article>
  `,
  styles: `
    .turn {
      display: grid;
      gap: 0.6rem;
    }
    .turn__label {
      font-size: 0.9rem;
      margin: 0;
      overflow-wrap: anywhere;
    }
    .question {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      margin: 0;
      padding: 0.6rem 0.85rem;
      background: var(--rl-accent-soft);
      border-radius: var(--rl-radius);
      justify-self: start;
      max-width: 100%;
    }
    .answer {
      padding: 1rem;
    }
    .answer__header {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      flex-wrap: wrap;
      margin-bottom: 0.5rem;
    }
    h3 {
      margin: 0;
      font-size: 1rem;
    }
    .answer__text {
      margin-bottom: 0.75rem;
    }
    .caret {
      display: inline-block;
      width: 0.5em;
      height: 1em;
      margin-left: 0.1em;
      vertical-align: text-bottom;
      background: var(--rl-accent);
      animation: blink 1s steps(2, start) infinite;
    }
    @keyframes blink {
      to {
        visibility: hidden;
      }
    }
    .no-sources {
      border: 1px solid var(--rl-warn);
      background: var(--rl-warn-soft);
      border-radius: var(--rl-radius);
      padding: 0.75rem 1rem;
    }
    .no-sources ul {
      margin: 0 0 0.75rem;
      padding-left: 1.25rem;
    }
    .no-sources p:last-child {
      margin: 0;
    }
    .note {
      font-size: 0.9rem;
    }
    .note--warn {
      color: var(--rl-warn);
      font-weight: 600;
    }
    .meta,
    .code {
      font-size: 0.85rem;
      margin: 0;
    }
    .rl-alert .rl-actions {
      margin-top: 0.5rem;
    }
  `,
})
export class ChatMessage {
  readonly turn = input.required<ChatTurn>();
  /** 1-based position in the conversation. */
  readonly index = input.required<number>();
  /** Another answer is streaming: retry is not possible right now. */
  readonly busy = input(false);
  readonly retry = output<ChatTurn>();
  /** Puts the question back into the composer (validation errors). */
  readonly edit = output<string>();

  private readonly sourceList = viewChild(SourceList);
  protected readonly highlighted = signal<number | null>(null);
  protected readonly prefix = computed(() => `turn-${this.turn().id}`);

  protected select(n: number): void {
    this.highlighted.set(n);
    this.sourceList()?.reveal(n);
  }

  protected onRetry(turn: ChatTurn): void {
    this.highlighted.set(null);
    this.retry.emit(turn);
  }

  protected errorTitle(error: TurnError): string {
    return ERROR_TITLES[error.kind];
  }

  protected bracketed(numbers: readonly number[]): string {
    return numbers.map((n) => `[${n}]`).join(', ');
  }

  protected seconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)} s`;
  }
}
