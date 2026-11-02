import {
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  afterNextRender,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { type ApiRequestError, toApiRequestError } from '../../core/api/api-error';
import { KnowledgeApi } from '../../core/api/knowledge-api';
import { plural } from '../../core/util/format';
import { CollectionForm, type CollectionFormValue } from './collection-form';

/** `/knowledge-bases`: all collections with counts, and the form to create one. */
@Component({
  selector: 'rl-knowledge-base-list-page',
  imports: [RouterLink, CollectionForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rl-page-header">
      <div>
        <h1>Knowledge Bases</h1>
        <p class="rl-muted">Collections of documents that RAGLab indexes and searches.</p>
      </div>
      @if (!formOpen() && hasCollections()) {
        <button #newButton type="button" class="rl-btn rl-btn--primary" (click)="openForm()">
          <span aria-hidden="true">+</span> New knowledge base
        </button>
      }
    </div>

    @if (formOpen()) {
      <section class="rl-card create" aria-labelledby="create-heading">
        <h2 id="create-heading">New knowledge base</h2>
        <p class="rl-muted">
          The embedding model configured on the server is recorded with the knowledge base and
          cannot be changed later.
        </p>
        <rl-collection-form
          submitLabel="Create knowledge base"
          [busy]="creating()"
          [serverError]="createError()"
          (save)="create($event)"
          (cancelled)="closeForm()"
        />
      </section>
    }

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
        @if (!formOpen()) {
          <section class="rl-card empty" aria-labelledby="empty-heading">
            <h2 id="empty-heading">No knowledge bases yet</h2>
            <p>
              A knowledge base holds Markdown and text files. RAGLab splits them into chunks, embeds
              them and makes them searchable for chat and retrieval.
            </p>
            <button type="button" class="rl-btn rl-btn--primary" (click)="openForm()">
              <span aria-hidden="true">+</span> Create your first knowledge base
            </button>
          </section>
        }
      } @else {
        <ul class="collections" aria-label="Knowledge bases">
          @for (collection of list; track collection.id) {
            <li class="rl-card collection">
              <h2>
                <a [routerLink]="['/knowledge-bases', collection.id]">{{ collection.name }}</a>
              </h2>
              @if (collection.description) {
                <p class="description">{{ collection.description }}</p>
              }
              <p class="counts">
                <span>{{ count(collection.documentCount, 'document') }}</span>
                <span>({{ collection.readyDocumentCount }} ready)</span>
                <span aria-hidden="true">·</span>
                <span>{{ count(collection.chunkCount, 'chunk') }}</span>
              </p>
              <p class="rl-muted model">
                Embedding: <code>{{ collection.embeddingModel }}</code> ({{
                  collection.embeddingDimensions
                }}
                dimensions)
              </p>
            </li>
          }
        </ul>
      }
    }
  `,
  styles: `
    .create {
      margin-bottom: 1.25rem;
      max-width: 760px;
    }
    .collections {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 1rem;
    }
    .collection h2 {
      overflow-wrap: anywhere;
    }
    .description {
      overflow-wrap: anywhere;
      white-space: pre-line;
    }
    .counts {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem;
      font-variant-numeric: tabular-nums;
    }
    .model {
      font-size: 0.85rem;
      margin: 0;
    }
    .empty {
      max-width: 640px;
    }
  `,
})
export class KnowledgeBaseListPage {
  private readonly api = inject(KnowledgeApi);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);

  protected readonly collections = rxResource({ stream: () => this.api.listCollections() });
  protected readonly formOpen = signal(false);
  protected readonly creating = signal(false);
  protected readonly createError = signal<ApiRequestError | undefined>(undefined);
  protected readonly count = plural;

  private readonly newButton = viewChild<ElementRef<HTMLButtonElement>>('newButton');
  private readonly form = viewChild(CollectionForm);

  protected hasCollections(): boolean {
    return this.collections.hasValue() && this.collections.value().length > 0;
  }

  protected openForm(): void {
    this.createError.set(undefined);
    this.formOpen.set(true);
    afterNextRender(() => this.form()?.focus(), { injector: this.injector });
  }

  protected closeForm(): void {
    this.formOpen.set(false);
    afterNextRender(() => this.newButton()?.nativeElement.focus(), { injector: this.injector });
  }

  protected async create(value: CollectionFormValue): Promise<void> {
    this.creating.set(true);
    this.createError.set(undefined);
    try {
      const created = await firstValueFrom(
        this.api.createCollection({
          name: value.name,
          ...(value.description ? { description: value.description } : {}),
        }),
      );
      await this.router.navigate(['/knowledge-bases', created.id]);
    } catch (error) {
      this.createError.set(toApiRequestError(error));
    } finally {
      this.creating.set(false);
    }
  }
}
