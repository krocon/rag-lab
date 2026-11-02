import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  signal,
  untracked,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import type { PlaygroundSearchResponse } from '@raglab/shared';
import { ApiRequestError } from '../../core/api/api-error';
import { KnowledgeApi } from '../../core/api/knowledge-api';
import { PlaygroundApi } from '../../core/api/playground-api';
import { plural } from '../../core/util/format';
import { PlaygroundDiagnostics, describeModel } from './playground-diagnostics';
import {
  MAX_TOP_K,
  type PlaygroundFormErrors,
  type PlaygroundFormValue,
  type PlaygroundParams,
  formFromParams,
  paramsFromForm,
  requestFromParams,
  validateForm,
} from './playground-query';
import { PlaygroundResults } from './playground-results';
import { PromptPreview } from './prompt-preview';

/** Field ids in form order (for moving the focus to the first invalid field). */
const FIELD_IDS: Record<keyof PlaygroundFormErrors, string> = {
  collectionId: 'pg-collection',
  query: 'pg-query',
  topK: 'pg-topk',
  minScore: 'pg-minscore',
};

/** Shown for `409 EMBEDDING_MODEL_MISMATCH` from the error details. */
export interface ModelMismatch {
  collection: string;
  configured: string;
}

export function modelMismatch(error: ApiRequestError): ModelMismatch | undefined {
  if (error.code !== 'EMBEDDING_MODEL_MISMATCH' || typeof error.details !== 'object') {
    return undefined;
  }
  const details = (error.details ?? {}) as Record<string, unknown>;
  const text = (key: string) => String(details[key] ?? '?');
  return {
    collection: describeModel({
      provider: text('collectionProvider'),
      model: text('collectionModel'),
      dimensions: Number(details['collectionDimensions'] ?? 0),
    }),
    configured: describeModel({
      provider: text('providerId'),
      model: text('providerModel'),
      dimensions: Number(details['providerDimensions'] ?? 0),
    }),
  };
}

/**
 * `/playground?collection=…&q=…&topK=…&minScore=…&prompt=1`: runs a query against a knowledge base
 * with the same retrieval as the chat and shows ranked chunks with score and distance, whether the
 * chat would use them, diagnostics and – optionally – the prompt. The search state lives in the
 * URL, so searches are shareable and survive a reload.
 */
@Component({
  selector: 'rl-playground-page',
  imports: [RouterLink, PlaygroundResults, PlaygroundDiagnostics, PromptPreview],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rl-page-header">
      <div>
        <h1>Retrieval Playground</h1>
        <p class="rl-muted">
          See what the retriever finds for a query and what the chat would send to the model –
          before an LLM is involved.
        </p>
      </div>
    </div>

    <p class="rl-visually-hidden" role="status" aria-live="polite">{{ announcement() }}</p>

    <form class="rl-card form" novalidate (submit)="$event.preventDefault(); submit()">
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
      } @else if (collections.hasValue() && collections.value().length === 0) {
        <p>
          There is no knowledge base yet.
          <a routerLink="/knowledge-bases">Create one and upload documents</a> to search it.
        </p>
      } @else if (collections.hasValue()) {
        @let f = form();
        @let e = errors();
        <div class="rl-field">
          <label for="pg-collection">Knowledge base</label>
          <select
            #picker
            id="pg-collection"
            [attr.aria-invalid]="e.collectionId ? 'true' : null"
            [attr.aria-describedby]="e.collectionId ? 'pg-collection-error' : null"
            (change)="update({ collectionId: picker.value })"
          >
            @if (!selectedCollection()) {
              <option value="" [selected]="true" disabled>Choose a knowledge base</option>
            }
            @for (collection of collections.value(); track collection.id) {
              <option [value]="collection.id" [selected]="collection.id === f.collectionId">
                {{ collection.name }}
                @if (collection.readyDocumentCount === 0) {
                  (no ready documents)
                }
              </option>
            }
          </select>
          @if (e.collectionId) {
            <p id="pg-collection-error" class="rl-field__error">{{ e.collectionId }}</p>
          }
        </div>

        <div class="rl-field">
          <label for="pg-query">Query</label>
          <textarea
            #queryField
            id="pg-query"
            name="query"
            rows="3"
            [value]="f.query"
            [attr.aria-invalid]="e.query ? 'true' : null"
            [attr.aria-describedby]="'pg-query-hint' + (e.query ? ' pg-query-error' : '')"
            (input)="update({ query: queryField.value })"
            (keydown)="onQueryKeydown($event)"
          ></textarea>
          <p id="pg-query-hint" class="rl-field__hint">
            {{ f.query.trim().length }}
            @if (maxQueryChars(); as max) {
              / {{ max }}
            }
            characters · <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Enter</kbd> searches
          </p>
          @if (e.query) {
            <p id="pg-query-error" class="rl-field__error">{{ e.query }}</p>
          }
        </div>

        <div class="row">
          <div class="rl-field">
            <label for="pg-topk">Top-K</label>
            <input
              #topKField
              id="pg-topk"
              type="number"
              inputmode="numeric"
              min="1"
              [attr.max]="maxTopK"
              step="1"
              [value]="f.topK"
              [attr.aria-invalid]="e.topK ? 'true' : null"
              [attr.aria-describedby]="'pg-topk-hint' + (e.topK ? ' pg-topk-error' : '')"
              (input)="update({ topK: topKField.value })"
            />
            <p id="pg-topk-hint" class="rl-field__hint">
              1–{{ maxTopK }}. Empty: server default
              @if (defaultTopK(); as k) {
                ({{ k }})
              }
            </p>
            @if (e.topK) {
              <p id="pg-topk-error" class="rl-field__error">{{ e.topK }}</p>
            }
          </div>

          <div class="rl-field">
            <label for="pg-minscore">minScore (optional)</label>
            <input
              #minScoreField
              id="pg-minscore"
              type="number"
              inputmode="decimal"
              min="-1"
              max="1"
              step="0.01"
              [value]="f.minScore"
              [attr.aria-invalid]="e.minScore ? 'true' : null"
              [attr.aria-describedby]="
                'pg-minscore-hint' + (e.minScore ? ' pg-minscore-error' : '')
              "
              (input)="update({ minScore: minScoreField.value })"
            />
            <p id="pg-minscore-hint" class="rl-field__hint">
              −1 to 1. Results with a lower score are flagged; the chat would drop them.
            </p>
            @if (e.minScore) {
              <p id="pg-minscore-error" class="rl-field__error">{{ e.minScore }}</p>
            }
          </div>
        </div>

        <div class="check">
          <input
            #promptField
            id="pg-prompt"
            type="checkbox"
            [checked]="f.includePrompt"
            (change)="update({ includePrompt: promptField.checked })"
          />
          <label for="pg-prompt">Show prompt (the messages the chat would send to the model)</label>
        </div>

        <div class="rl-actions">
          <button type="submit" class="rl-btn rl-btn--primary">
            <span aria-hidden="true">⌕</span> Search
          </button>
          @if (f.collectionId && f.query.trim()) {
            <a
              class="rl-btn"
              routerLink="/chat"
              [queryParams]="{ collection: f.collectionId, q: f.query.trim() }"
              ><span aria-hidden="true">✎</span> Ask in chat</a
            >
          }
        </div>
      }
    </form>

    <div class="result-area" [attr.aria-busy]="search.isLoading()">
      @if (!request()) {
        @if (linkProblem(); as problem) {
          <div class="rl-alert rl-alert--warn" role="alert">
            <p><span aria-hidden="true">⚠</span> {{ problem }}</p>
          </div>
        } @else {
          <section class="rl-card intro" aria-labelledby="pg-intro-heading">
            <h2 id="pg-intro-heading">How it works</h2>
            <ol>
              <li>Choose a knowledge base and enter a query – like a chat question.</li>
              <li>
                RAGLab embeds the query and returns the top-K chunks by cosine distance, using the
                same retrieval service as the chat.
              </li>
              <li>
                Each hit shows its <strong>score</strong> (1 − cosine distance, higher is more
                similar) and <strong>distance</strong>, and whether the chat would send it to the
                model.
              </li>
            </ol>
            <p class="rl-muted">The search is kept in the URL – copy it to share or repeat it.</p>
          </section>
        }
      } @else if (search.isLoading()) {
        <p class="rl-card loading" role="status">Searching…</p>
      } @else if (searchError(); as error) {
        <div class="rl-alert" [class.rl-alert--warn]="error.status === 409" role="alert">
          @if (mismatch(); as m) {
            <p><strong>Embedding model mismatch</strong></p>
            <p>
              This knowledge base was embedded with another model than the one configured now.
              Distances between different models are meaningless, so the search is refused.
            </p>
            <dl class="rl-dl">
              <dt>Knowledge base</dt>
              <dd>{{ m.collection }}</dd>
              <dt>Configured</dt>
              <dd>{{ m.configured }}</dd>
            </dl>
            <p class="fix">
              Restore the original embedding configuration or create a new knowledge base.
            </p>
          } @else {
            <p><span aria-hidden="true">✕</span> {{ errorTitle(error) }} {{ error.message }}</p>
            @if (error.detail('hint'); as hint) {
              <p>{{ hint }}</p>
            }
            @for (issue of error.validationIssues; track issue.location) {
              <p>
                <code>{{ issue.location }}</code
                >: {{ issue.message }}
              </p>
            }
            <button type="button" class="rl-btn" (click)="search.reload()">Try again</button>
          }
        </div>
      } @else if (search.hasValue()) {
        @let r = search.value();
        <div class="layout">
          <section class="rl-card results" aria-labelledby="pg-results-heading">
            <h2 id="pg-results-heading">Results</h2>
            <p class="summary">{{ summary(r) }}</p>
            @if (r.results.length > 0) {
              <rl-playground-results [results]="r.results" [collectionId]="r.collectionId" />
            } @else {
              <div class="empty">
                @switch (r.emptyReason) {
                  @case ('collection_empty') {
                    <p>
                      <strong>This knowledge base has no documents.</strong>
                      <a [routerLink]="['/knowledge-bases', r.collectionId]">Upload documents</a>
                      to search them.
                    </p>
                  }
                  @case ('no_indexed_chunks') {
                    <p>
                      <strong>Nothing can be searched yet.</strong> No document is ready or no chunk
                      has an embedding.
                      <a [routerLink]="['/knowledge-bases', r.collectionId]">Check the documents</a>
                      – wait for indexing or reindex failed documents.
                    </p>
                  }
                  @default {
                    <p><strong>No results.</strong></p>
                  }
                }
              </div>
            }
          </section>
          <rl-playground-diagnostics class="diagnostics" [response]="r" />
        </div>
        @if (r.prompt; as prompt) {
          <rl-prompt-preview class="prompt" [prompt]="prompt" />
        }
      }
    </div>
  `,
  styles: `
    .form {
      margin-bottom: 1.25rem;
      max-width: 60rem;
    }
    select {
      font: inherit;
      color: var(--rl-text);
      background: var(--rl-surface);
      border: 1px solid var(--rl-border-strong);
      border-radius: 6px;
      padding: 0.45rem 0.6rem;
      max-width: 40rem;
    }
    .row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
      gap: 0 1.25rem;
    }
    .check {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }
    .check input {
      width: 1.1rem;
      height: 1.1rem;
      accent-color: var(--rl-accent);
    }
    kbd {
      border: 1px solid var(--rl-border-strong);
      border-radius: 4px;
      padding: 0 0.3em;
      background: var(--rl-surface-muted);
    }
    a.rl-btn {
      text-decoration: none;
    }
    .intro {
      max-width: 760px;
    }
    .intro ol {
      padding-left: 1.25rem;
    }
    .loading {
      max-width: 40rem;
    }
    .layout {
      display: grid;
      gap: 1.25rem;
      align-items: start;
    }
    @media (min-width: 1600px) {
      .layout {
        grid-template-columns: minmax(0, 1fr) 20rem;
      }
    }
    .results {
      min-width: 0;
    }
    .summary {
      font-weight: 600;
    }
    .prompt {
      display: block;
      margin-top: 1.25rem;
    }
    .fix {
      margin-top: 0.75rem;
    }
  `,
})
export class PlaygroundPage {
  /** Query parameters (bound by the router). */
  readonly collection = input<string | undefined>(undefined);
  readonly q = input<string | undefined>(undefined);
  readonly topK = input<string | undefined>(undefined);
  readonly minScore = input<string | undefined>(undefined);
  readonly prompt = input<string | undefined>(undefined);

  private readonly knowledgeApi = inject(KnowledgeApi);
  private readonly playgroundApi = inject(PlaygroundApi);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly maxTopK = MAX_TOP_K;

  protected readonly collections = rxResource({
    stream: () => this.knowledgeApi.listCollections(),
  });
  private readonly systemInfo = rxResource({ stream: () => this.knowledgeApi.getSystemInfo() });

  protected readonly maxQueryChars = computed(() =>
    this.systemInfo.hasValue() ? this.systemInfo.value().retrieval.maxQueryChars : undefined,
  );
  protected readonly defaultTopK = computed(() =>
    this.systemInfo.hasValue() ? this.systemInfo.value().retrieval.defaultTopK : undefined,
  );

  private readonly params = computed<PlaygroundParams>(() => ({
    collection: this.collection(),
    q: this.q(),
    topK: this.topK(),
    minScore: this.minScore(),
    prompt: this.prompt(),
  }));

  /** The form follows the URL (reload, back/forward) and keeps edits until the next search. */
  protected readonly form = linkedSignal<PlaygroundFormValue>(() => formFromParams(this.params()));
  /** Validation errors, shown after a search attempt. */
  protected readonly errors = signal<PlaygroundFormErrors>({});

  /** The search described by the URL; `undefined` shows the form only. */
  protected readonly request = computed(() => requestFromParams(this.params()));

  protected readonly search = rxResource({
    params: () => this.request(),
    stream: ({ params }) => this.playgroundApi.search(params),
  });

  protected readonly selectedCollection = computed(() => {
    const id = this.form().collectionId;
    return this.collections.hasValue()
      ? this.collections.value().find((collection) => collection.id === id)
      : undefined;
  });

  /** A link with search parameters that cannot be used. */
  protected readonly linkProblem = computed(() => {
    const params = this.params();
    const used = Object.values(params).some((value) => value !== undefined && value !== '');
    if (!used) {
      return undefined;
    }
    const problems = Object.values(validateForm(formFromParams(params)));
    return problems.length > 0
      ? `This link cannot be searched: ${problems.join(' ')} Correct the form and search again.`
      : undefined;
  });

  protected readonly searchError = computed(() => {
    const error = this.search.error();
    return error instanceof ApiRequestError
      ? error
      : error
        ? new ApiRequestError(0, 'UNKNOWN_ERROR', error.message)
        : undefined;
  });

  protected readonly mismatch = computed(() => {
    const error = this.searchError();
    return error ? modelMismatch(error) : undefined;
  });

  protected readonly announcement = computed(() => {
    if (this.search.isLoading()) {
      return 'Searching…';
    }
    if (this.search.hasValue()) {
      return this.summary(this.search.value());
    }
    return '';
  });

  constructor() {
    // A knowledge base deleted in the meantime: refresh the list so the picker is correct.
    effect(() => {
      if (this.searchError()?.code === 'COLLECTION_NOT_FOUND') {
        untracked(() => this.collections.reload());
      }
    });
  }

  protected update(patch: Partial<PlaygroundFormValue>): void {
    this.form.update((value) => ({ ...value, ...patch }));
    // Errors disappear as soon as the field is corrected.
    if (Object.keys(this.errors()).length > 0) {
      this.errors.set(validateForm(this.form(), this.maxQueryChars()));
    }
  }

  protected onQueryKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      this.submit();
    }
  }

  protected submit(): void {
    const value = this.form();
    const errors = validateForm(value, this.maxQueryChars());
    this.errors.set(errors);
    const firstInvalid = (Object.keys(FIELD_IDS) as (keyof PlaygroundFormErrors)[]).find(
      (key) => errors[key] !== undefined,
    );
    if (firstInvalid) {
      this.host.nativeElement.querySelector<HTMLElement>(`#${FIELD_IDS[firstInvalid]}`)?.focus();
      return;
    }
    const next = paramsFromForm(value);
    const current = paramsFromForm(formFromParams(this.params()));
    if (JSON.stringify(next) === JSON.stringify(current)) {
      // Same URL: the router would not change anything, so search again explicitly.
      this.search.reload();
      return;
    }
    void this.router.navigate([], { queryParams: next });
  }

  protected errorTitle(error: ApiRequestError): string {
    switch (error.code) {
      case 'COLLECTION_NOT_FOUND':
        return 'The knowledge base does not exist (anymore).';
      case 'EMBEDDING_PROVIDER_UNAVAILABLE':
        return 'The embedding provider is not reachable.';
      case 'EMBEDDING_PROVIDER_ERROR':
      case 'EMBEDDING_DIMENSION_MISMATCH':
        return 'The query could not be embedded.';
      case 'VALIDATION_ERROR':
        return 'The search parameters are invalid.';
      default:
        return 'The search failed.';
    }
  }

  protected summary(response: PlaygroundSearchResponse): string {
    const { chatContext } = response;
    if (response.results.length === 0) {
      return 'No results – the chat would answer without sources.';
    }
    const parts = [
      plural(response.results.length, 'result'),
      `${chatContext.includedCount} in chat context`,
    ];
    if (chatContext.omittedByBudgetCount > 0) {
      parts.push(`${chatContext.omittedByBudgetCount} outside budget`);
    }
    if (chatContext.belowMinScoreCount > 0) {
      parts.push(`${chatContext.belowMinScoreCount} below minScore`);
    }
    return `${parts.join(' · ')}.`;
  }
}
