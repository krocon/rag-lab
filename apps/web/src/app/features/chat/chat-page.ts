import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  untracked,
  viewChild,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import type { CollectionDto } from '@raglab/shared';
import { KnowledgeApi } from '../../core/api/knowledge-api';
import { ChatComposer } from './chat-composer';
import { ChatMessage } from './chat-message';
import { ChatStore, type ChatTurn } from './chat.store';

/** A knowledge base can be asked once at least one of its documents is `ready`. */
export function isAskable(collection: CollectionDto): boolean {
  return collection.readyDocumentCount > 0;
}

/**
 * `/chat[?collection=<id>][&q=<question>]`: ask a knowledge base and get a streamed answer with
 * sources. `q` pre-fills the question (e.g. "Ask in chat" from the playground) without sending it.
 * The conversation lives in `ChatStore` (memory only).
 */
@Component({
  selector: 'rl-chat-page',
  imports: [RouterLink, ChatComposer, ChatMessage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown.escape)': 'onEscape($event)' },
  template: `
    <div class="rl-page-header">
      <div>
        <h1>Chat</h1>
        <p class="rl-muted">Ask a knowledge base. Answers cite the passages they are based on.</p>
      </div>
      <button
        type="button"
        class="rl-btn"
        [disabled]="store.turns().length === 0 && !store.busy()"
        (click)="newChat()"
      >
        <span aria-hidden="true">+</span> New chat
      </button>
    </div>

    <p class="rl-visually-hidden" role="status" aria-live="polite">{{ store.announcement() }}</p>

    <p class="notice" role="note">
      <span aria-hidden="true">ⓘ</span>
      Answers are generated from your documents. A manipulated document can steer the answer –
      always check the cited sources.
    </p>

    <div class="rl-card picker">
      @if (collections.isLoading() && !collections.hasValue()) {
        <p role="status">Loading knowledge bases…</p>
      } @else if (collections.error(); as error) {
        <div class="rl-alert" role="alert">
          <p>
            <span aria-hidden="true">✕</span> The knowledge bases could not be loaded.
            {{ error.message }}
          </p>
          <button type="button" class="rl-btn" (click)="collections.reload()">Try again</button>
        </div>
      } @else if (collections.hasValue()) {
        @let list = collections.value();
        @if (list.length === 0) {
          <p>
            There is no knowledge base yet.
            <a routerLink="/knowledge-bases">Create one and upload documents</a> to start asking
            questions.
          </p>
        } @else {
          <div class="rl-field">
            <label for="chat-collection">Knowledge base</label>
            <select
              #picker
              id="chat-collection"
              aria-describedby="chat-collection-hint"
              (change)="choose(picker.value)"
            >
              @if (!current()) {
                <option value="" [selected]="true" disabled>Choose a knowledge base</option>
              }
              @for (collection of list; track collection.id) {
                <option
                  [value]="collection.id"
                  [disabled]="!askable(collection)"
                  [selected]="collection.id === current()?.id"
                >
                  {{ collection.name }}
                  @if (!askable(collection)) {
                    (no ready documents)
                  }
                </option>
              }
            </select>
            <p id="chat-collection-hint" class="rl-field__hint">
              Only knowledge bases with at least one ready document can be asked.
              <a routerLink="/knowledge-bases">Manage knowledge bases</a>
            </p>
          </div>
          @if (linkProblem(); as problem) {
            <div class="rl-alert rl-alert--warn" role="alert">
              <p><span aria-hidden="true">⚠</span> {{ problem }}</p>
            </div>
          }
        }
      }
    </div>

    @let turns = store.turns();
    @if (turns.length === 0) {
      <section class="rl-card empty" aria-labelledby="empty-heading">
        <h2 id="empty-heading">How it works</h2>
        <ol>
          <li>Choose a knowledge base with ready documents.</li>
          <li>
            Ask a question. RAGLab searches the knowledge base and sends the best passages to the
            chat model as numbered sources.
          </li>
          <li>
            The answer streams in and cites its sources as <strong>[1]</strong>,
            <strong>[2]</strong>, … – select a citation to highlight the source, and open the
            passage in its document to check it.
          </li>
        </ol>
        <p class="rl-muted">
          Each question is answered on its own; the conversation is kept in this browser tab only.
        </p>
      </section>
    } @else {
      <ol class="turns" aria-label="Conversation">
        @for (turn of turns; track turn.id; let i = $index) {
          <li [attr.data-turn]="turn.id">
            <rl-chat-message
              [turn]="turn"
              [index]="i + 1"
              [busy]="store.busy()"
              (retry)="retry($event)"
              (edit)="composer().setQuestion($event)"
            />
          </li>
        }
      </ol>
    }

    <div #composerBar class="composer-bar">
      <rl-chat-composer
        [busy]="store.busy()"
        [unavailable]="unavailable()"
        (send)="send($event)"
        (cancelled)="store.cancel()"
      />
    </div>
  `,
  styles: `
    .notice {
      font-size: 0.9rem;
      color: var(--rl-text-muted);
      border-left: 3px solid var(--rl-warn);
      padding: 0.25rem 0 0.25rem 0.6rem;
      max-width: 80ch;
    }
    .picker {
      padding: 1rem 1.25rem;
      margin-bottom: 1.25rem;
    }
    .picker .rl-field {
      margin: 0;
      max-width: 40rem;
    }
    select {
      font: inherit;
      color: var(--rl-text);
      background: var(--rl-surface);
      border: 1px solid var(--rl-border-strong);
      border-radius: 6px;
      padding: 0.45rem 0.6rem;
    }
    .picker .rl-alert {
      margin: 0.75rem 0 0;
    }
    .empty {
      max-width: 760px;
    }
    .empty ol {
      padding-left: 1.25rem;
    }
    .turns {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 1.5rem;
    }
    .turns > li {
      scroll-margin-top: 1rem;
    }
    .composer-bar {
      position: sticky;
      bottom: 0;
      margin-top: 1.25rem;
      padding: 0.75rem 0 1rem;
      background: var(--rl-bg);
      border-top: 1px solid var(--rl-border);
    }
  `,
})
export class ChatPage {
  /** Query parameter `?collection=<id>`. */
  readonly collection = input<string | undefined>(undefined);
  /** Query parameter `?q=<question>`: pre-fills the question field (never sends it). */
  readonly q = input<string | undefined>(undefined);

  protected readonly store = inject(ChatStore);
  private readonly api = inject(KnowledgeApi);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly composer = viewChild.required(ChatComposer);
  private readonly composerBar = viewChild.required<ElementRef<HTMLElement>>('composerBar');
  private readonly document = inject(DOCUMENT);
  protected readonly askable = isAskable;

  protected readonly collections = rxResource({
    stream: () => this.api.listCollections(),
  });

  /** Requested knowledge base: the link's, otherwise the one used last in this session. */
  private readonly requestedId = linkedSignal(
    () => this.collection() || this.store.lastCollectionId(),
  );

  /** The knowledge base questions go to; `undefined` if none can be asked. */
  protected readonly current = computed<CollectionDto | undefined>(() => {
    if (!this.collections.hasValue()) {
      return undefined;
    }
    const list = this.collections.value();
    const id = this.requestedId();
    if (id !== undefined) {
      const requested = list.find((c) => c.id === id);
      return requested && isAskable(requested) ? requested : undefined;
    }
    return list.find(isAskable);
  });

  /** Why the requested knowledge base cannot be used (link or earlier selection). */
  protected readonly linkProblem = computed(() => {
    const id = this.requestedId();
    if (id === undefined || !this.collections.hasValue()) {
      return undefined;
    }
    const requested = this.collections.value().find((c) => c.id === id);
    if (!requested) {
      return 'The requested knowledge base does not exist (anymore). Choose another one.';
    }
    return isAskable(requested)
      ? undefined
      : `“${requested.name}” has no ready documents yet, so it cannot be asked. Choose another one or wait until indexing is finished.`;
  });

  protected readonly unavailable = computed(() => {
    if (!this.collections.hasValue()) {
      return this.collections.error()
        ? 'The knowledge bases could not be loaded.'
        : 'Loading knowledge bases…';
    }
    if (!this.collections.value().some(isAskable)) {
      return 'No knowledge base has ready documents yet – upload and index documents first.';
    }
    return this.current() ? null : 'Choose a knowledge base first.';
  });

  constructor() {
    this.keepFocusAboveComposer();

    // Pre-fill the question from the link once per value; the user reviews and sends it.
    let prefilled: string | undefined;
    afterRenderEffect(() => {
      const question = this.q()?.trim();
      if (question && question !== prefilled) {
        prefilled = question;
        untracked(() => this.composer().setQuestion(question));
      }
    });

    // A knowledge base deleted in the meantime: refresh the list so the picker is correct.
    effect(() => {
      const turns = this.store.turns();
      const last = turns[turns.length - 1];
      if (last?.error()?.code === 'COLLECTION_NOT_FOUND') {
        untracked(() => this.collections.reload());
      }
    });
  }

  protected choose(id: string): void {
    this.requestedId.set(id);
    this.store.lastCollectionId.set(id);
    void this.router.navigate([], {
      queryParams: { collection: id },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  protected send(question: string): void {
    const collection = this.current();
    if (!collection) {
      return;
    }
    this.store.lastCollectionId.set(collection.id);
    const turn = this.store.send({ id: collection.id, name: collection.name }, question);
    if (turn) {
      this.scrollTo(turn);
    }
  }

  protected retry(turn: ChatTurn): void {
    this.store.retry(turn);
  }

  protected newChat(): void {
    this.store.clear();
    this.composer().focus();
  }

  protected onEscape(event: Event): void {
    if (this.store.busy()) {
      event.preventDefault();
      this.store.cancel();
    }
  }

  /**
   * The composer sticks to the bottom of the viewport. So that it never hides the focused element
   * (WCAG 2.4.11) or a source revealed by a citation, the document gets a matching
   * `scroll-padding-bottom` while this page is shown.
   */
  private keepFocusAboveComposer(): void {
    const root = this.document.documentElement;
    let observer: ResizeObserver | undefined;
    afterRenderEffect(() => {
      const bar = this.composerBar().nativeElement;
      if (observer || typeof ResizeObserver === 'undefined') {
        return;
      }
      const update = () => {
        root.style.scrollPaddingBottom = `${Math.ceil(bar.getBoundingClientRect().height) + 16}px`;
      };
      observer = new ResizeObserver(update);
      observer.observe(bar);
      update();
    });
    inject(DestroyRef).onDestroy(() => {
      observer?.disconnect();
      root.style.removeProperty('scroll-padding-bottom');
    });
  }

  /** Brings a new question into view once it is rendered (the focus stays in the composer). */
  private scrollTo(turn: ChatTurn): void {
    afterNextRender(
      () => {
        const element = this.host.nativeElement.querySelector<HTMLElement>(
          `[data-turn="${turn.id}"]`,
        );
        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
        element?.scrollIntoView?.({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
      },
      { injector: this.injector },
    );
  }
}
