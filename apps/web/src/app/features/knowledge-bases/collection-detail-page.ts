import {
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import type { DocumentDto, DocumentStatus } from '@raglab/shared';
import { firstValueFrom } from 'rxjs';
import { ApiRequestError, toApiRequestError } from '../../core/api/api-error';
import { KnowledgeApi } from '../../core/api/knowledge-api';
import { plural } from '../../core/util/format';
import { pollWhile } from '../../core/util/polling';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog';
import { CollectionForm, type CollectionFormValue } from './collection-form';
import { DOCUMENT_STATUS_PRESENTATION, isActiveStatus } from './document-status';
import { DocumentTable } from './document-table';
import { DocumentUpload } from './document-upload';

type PendingDelete = { kind: 'collection' } | { kind: 'document'; document: DocumentDto };

/**
 * `/knowledge-bases/:collectionId`: collection header (edit, delete), upload and document table.
 * While documents are `pending`/`processing`, their status is polled (stops when all are done or
 * the page is left).
 */
@Component({
  selector: 'rl-collection-detail-page',
  imports: [RouterLink, CollectionForm, ConfirmDialog, DocumentTable, DocumentUpload],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="rl-breadcrumb" aria-label="Breadcrumb">
      <ol>
        <li><a routerLink="/knowledge-bases">Knowledge Bases</a></li>
        <li aria-current="page">
          {{ collection.hasValue() ? collection.value().name : 'Knowledge base' }}
        </li>
      </ol>
    </nav>

    <p class="rl-visually-hidden" role="status" aria-live="polite">{{ announcement() }}</p>

    @if (collection.isLoading() && !collection.hasValue()) {
      <p role="status">Loading knowledge base…</p>
    } @else if (collection.error(); as error) {
      @if (isNotFound(error)) {
        <h1>Knowledge base not found</h1>
        <p>It may have been deleted.</p>
        <p><a routerLink="/knowledge-bases">Back to all knowledge bases</a></p>
      } @else {
        <h1>Knowledge base</h1>
        <div class="rl-alert" role="alert">
          <p>
            <span aria-hidden="true">✕</span> The knowledge base could not be loaded.
            {{ error.message }}
          </p>
          <button type="button" class="rl-btn" (click)="collection.reload()">Try again</button>
        </div>
      }
    } @else if (collection.hasValue()) {
      @let kb = collection.value();
      @if (editing()) {
        <section class="rl-card section" aria-labelledby="edit-heading">
          <h1 id="edit-heading">Edit “{{ kb.name }}”</h1>
          <rl-collection-form
            submitLabel="Save changes"
            [initial]="kb"
            [busy]="saving()"
            [serverError]="saveError()"
            (save)="save($event)"
            (cancelled)="stopEditing()"
          />
        </section>
      } @else {
        <header class="rl-page-header">
          <div>
            <h1>{{ kb.name }}</h1>
            @if (kb.description) {
              <p class="description">{{ kb.description }}</p>
            } @else {
              <p class="rl-muted">No description.</p>
            }
          </div>
          <div class="rl-actions">
            <button #editButton type="button" class="rl-btn" (click)="startEditing()">Edit</button>
            <button type="button" class="rl-btn rl-btn--danger" (click)="askDeleteCollection()">
              Delete knowledge base
            </button>
          </div>
        </header>
      }

      <dl class="rl-dl rl-card section facts">
        <dt>Embedding model</dt>
        <dd>
          <code>{{ kb.embeddingModel }}</code> ({{ kb.embeddingProvider }})
        </dd>
        <dt>Embedding dimensions</dt>
        <dd>{{ kb.embeddingDimensions }}</dd>
        <dt>Documents</dt>
        <dd>{{ kb.documentCount }} ({{ kb.readyDocumentCount }} ready)</dd>
        <dt>Chunks</dt>
        <dd>{{ kb.chunkCount }}</dd>
      </dl>

      @if (providerProblem(); as problem) {
        <div class="rl-alert rl-alert--warn section" role="note" data-testid="provider-warning">
          <p>
            <strong><span aria-hidden="true">⚠</span> Indexing will fail:</strong>
            {{ problem.error }}
          </p>
          @if (problem.hint) {
            <p>{{ problem.hint }}</p>
          }
          <p class="rl-muted">
            Documents end as “Failed”. Fix the provider, then reindex them. See
            <a routerLink="/settings">Settings</a> for the configuration.
          </p>
        </div>
      }

      <section class="rl-card section" aria-labelledby="upload-heading">
        <h2 id="upload-heading">Upload documents</h2>
        <rl-document-upload [collectionId]="kb.id" (uploaded)="onUploaded()" />
      </section>

      <section class="rl-card section" aria-labelledby="documents-heading">
        <div class="documents-header">
          <h2 id="documents-heading" tabindex="-1">Documents</h2>
          @if (polling()) {
            <span class="rl-badge rl-badge--info" data-testid="polling-indicator">
              <span aria-hidden="true">⟳</span> Updating status automatically
            </span>
          }
        </div>
        @if (actionError(); as message) {
          <div class="rl-alert" role="alert">
            <p><span aria-hidden="true">✕</span> {{ message }}</p>
          </div>
        }
        @if (documents.isLoading() && !documents.hasValue()) {
          <p role="status">Loading documents…</p>
        } @else if (documents.error(); as error) {
          <div class="rl-alert" role="alert">
            <p>
              <span aria-hidden="true">✕</span> The documents could not be loaded.
              {{ error.message }}
            </p>
            <button type="button" class="rl-btn" (click)="documents.reload()">Try again</button>
          </div>
        } @else if (documents.hasValue()) {
          @if (documents.value().length === 0) {
            <p class="rl-muted">No documents yet. Upload Markdown or text files above.</p>
          } @else {
            <rl-document-table
              [documents]="documents.value()"
              [caption]="tableCaption()"
              [busyIds]="busyIds()"
              (reindex)="reindex($event)"
              (remove)="askDeleteDocument($event)"
            />
          }
        }
      </section>

      <rl-confirm-dialog
        [open]="pendingDelete() !== undefined"
        [heading]="deleteHeading()"
        [busy]="deleting()"
        [error]="deleteError()"
        (confirmed)="confirmDelete()"
        (cancelled)="cancelDelete()"
      >
        @switch (pendingDelete()?.kind) {
          @case ('collection') {
            <p>
              This permanently deletes the knowledge base “{{ kb.name }}” with
              {{ count(kb.documentCount, 'document') }} and {{ count(kb.chunkCount, 'chunk') }}.
              This cannot be undone.
            </p>
          }
          @case ('document') {
            <p>
              This permanently deletes “{{ pendingDocument()?.filename }}” and all of its chunks.
              This cannot be undone.
            </p>
          }
        }
      </rl-confirm-dialog>
    }
  `,
  styles: `
    .section {
      margin-bottom: 1.25rem;
    }
    .description {
      white-space: pre-line;
      overflow-wrap: anywhere;
      max-width: 70ch;
    }
    .documents-header {
      display: flex;
      gap: 0.75rem;
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: 0.5rem;
    }
    .documents-header h2 {
      margin: 0;
    }
  `,
})
export class CollectionDetailPage {
  /** Route parameter (`withComponentInputBinding`). */
  readonly collectionId = input.required<string>();

  private readonly api = inject(KnowledgeApi);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  protected readonly count = plural;

  protected readonly collection = rxResource({
    params: () => this.collectionId(),
    stream: ({ params }) => this.api.getCollection(params),
  });
  protected readonly documents = rxResource({
    params: () => this.collectionId(),
    stream: ({ params }) => this.api.listDocuments(params),
  });
  private readonly providers = rxResource({ stream: () => this.api.getProviders() });

  /** Embedding provider problems that make indexing fail (reported by the API, not guessed). */
  protected readonly providerProblem = computed(() => {
    if (!this.providers.hasValue()) {
      return undefined;
    }
    const embedding = this.providers.value().embedding;
    if (embedding.reachable && embedding.modelAvailable !== false) {
      return undefined;
    }
    return {
      error:
        embedding.error ??
        (embedding.reachable
          ? `Embedding model “${embedding.model}” is not available.`
          : `Embedding provider “${embedding.provider}” is not reachable.`),
      hint: embedding.hint,
    };
  });

  protected readonly polling = computed(
    () =>
      this.documents.hasValue() &&
      this.documents.value().some((document) => isActiveStatus(document.status)),
  );

  protected readonly tableCaption = computed(() => {
    const documents = this.documents.hasValue() ? this.documents.value() : [];
    const active = documents.filter((document) => isActiveStatus(document.status)).length;
    const failed = documents.filter((document) => document.status === 'failed').length;
    const parts = [plural(documents.length, 'document')];
    if (active > 0) parts.push(`${active} in progress`);
    if (failed > 0) parts.push(`${failed} failed`);
    return `Documents: ${parts.join(', ')}`;
  });

  protected readonly announcement = signal('');
  protected readonly editing = signal(false);
  protected readonly saving = signal(false);
  protected readonly saveError = signal<ApiRequestError | undefined>(undefined);
  protected readonly busyIds = signal<ReadonlySet<string>>(new Set());
  protected readonly actionError = signal<string | undefined>(undefined);
  protected readonly pendingDelete = signal<PendingDelete | undefined>(undefined);
  protected readonly deleting = signal(false);
  protected readonly deleteError = signal<string | undefined>(undefined);

  protected readonly pendingDocument = computed(() => {
    const pending = this.pendingDelete();
    return pending?.kind === 'document' ? pending.document : undefined;
  });
  protected readonly deleteHeading = computed(() =>
    this.pendingDelete()?.kind === 'document' ? 'Delete document?' : 'Delete knowledge base?',
  );

  private readonly editButton = viewChild<ElementRef<HTMLButtonElement>>('editButton');
  private readonly form = viewChild(CollectionForm);

  constructor() {
    // Poll only after the previous answer arrived (not loading), so requests never overlap.
    pollWhile(
      () => !this.documents.isLoading() && this.polling(),
      () => this.documents.reload(),
    );
    this.announceStatusChanges();
  }

  protected isNotFound(error: Error): boolean {
    return error instanceof ApiRequestError && error.status === 404;
  }

  protected onUploaded(): void {
    this.documents.reload();
    this.collection.reload();
  }

  protected startEditing(): void {
    this.saveError.set(undefined);
    this.editing.set(true);
    afterNextRender(() => this.form()?.focus(), { injector: this.injector });
  }

  protected stopEditing(): void {
    this.editing.set(false);
    afterNextRender(() => this.editButton()?.nativeElement.focus(), { injector: this.injector });
  }

  protected async save(value: CollectionFormValue): Promise<void> {
    this.saving.set(true);
    this.saveError.set(undefined);
    try {
      const updated = await firstValueFrom(
        this.api.updateCollection(this.collectionId(), {
          name: value.name,
          description: value.description,
        }),
      );
      this.collection.set(updated);
      this.announcement.set('Changes saved.');
      this.stopEditing();
    } catch (error) {
      this.saveError.set(toApiRequestError(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected async reindex(document: DocumentDto): Promise<void> {
    this.actionError.set(undefined);
    this.setBusy(document.id, true);
    try {
      const updated = await firstValueFrom(this.api.reindexDocument(document.id));
      this.replaceDocument(updated);
      this.announcement.set(`“${document.filename}” queued for reindexing.`);
    } catch (error) {
      this.actionError.set(
        `“${document.filename}” could not be reindexed: ${toApiRequestError(error).message}`,
      );
      this.documents.reload();
    } finally {
      this.setBusy(document.id, false);
    }
  }

  protected askDeleteCollection(): void {
    this.deleteError.set(undefined);
    this.pendingDelete.set({ kind: 'collection' });
  }

  protected askDeleteDocument(document: DocumentDto): void {
    this.deleteError.set(undefined);
    this.pendingDelete.set({ kind: 'document', document });
  }

  protected cancelDelete(): void {
    this.pendingDelete.set(undefined);
  }

  protected async confirmDelete(): Promise<void> {
    const pending = this.pendingDelete();
    if (!pending) {
      return;
    }
    this.deleting.set(true);
    this.deleteError.set(undefined);
    try {
      if (pending.kind === 'collection') {
        await firstValueFrom(this.api.deleteCollection(this.collectionId()), {
          defaultValue: undefined,
        });
        this.pendingDelete.set(undefined);
        await this.router.navigate(['/knowledge-bases']);
        return;
      }
      await firstValueFrom(this.api.deleteDocument(pending.document.id), {
        defaultValue: undefined,
      });
      this.pendingDelete.set(undefined);
      this.announcement.set(`“${pending.document.filename}” deleted.`);
      this.documents.reload();
      this.collection.reload();
      // The row (and its button) is gone: continue at the table heading.
      afterNextRender(() => document.getElementById('documents-heading')?.focus(), {
        injector: this.injector,
      });
    } catch (error) {
      this.deleteError.set(toApiRequestError(error).message);
    } finally {
      this.deleting.set(false);
    }
  }

  private setBusy(id: string, busy: boolean): void {
    this.busyIds.update((ids) => {
      const next = new Set(ids);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  private replaceDocument(updated: DocumentDto): void {
    if (this.documents.hasValue()) {
      this.documents.set(
        this.documents.value().map((document) => (document.id === updated.id ? updated : document)),
      );
    }
  }

  /** Announces status transitions (e.g. processing → ready) via the polite live region. */
  private announceStatusChanges(): void {
    let previous = new Map<string, DocumentStatus>();
    effect(() => {
      if (!this.documents.hasValue()) {
        return;
      }
      const documents = this.documents.value();
      const messages: string[] = [];
      let finished = false;
      for (const document of documents) {
        const before = previous.get(document.id);
        if (before !== undefined && before !== document.status) {
          messages.push(
            `“${document.filename}”: ${DOCUMENT_STATUS_PRESENTATION[document.status].label.toLowerCase()}.`,
          );
          finished ||= !isActiveStatus(document.status);
        }
      }
      previous = new Map(documents.map((document) => [document.id, document.status]));
      untracked(() => {
        if (messages.length > 0) {
          this.announcement.set(messages.join(' '));
        }
        // Counts in the header change when documents finish.
        if (finished) {
          this.collection.reload();
        }
      });
    });
  }
}
