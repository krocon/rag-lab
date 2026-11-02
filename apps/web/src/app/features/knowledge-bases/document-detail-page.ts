import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import type { DocumentStatus } from '@raglab/shared';
import { firstValueFrom } from 'rxjs';
import { ApiRequestError, toApiRequestError } from '../../core/api/api-error';
import { KnowledgeApi } from '../../core/api/knowledge-api';
import { formatBytes, plural } from '../../core/util/format';
import { pollWhile } from '../../core/util/polling';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog';
import { DocumentStatusBadge, isActiveStatus } from './document-status';

/**
 * `/knowledge-bases/:collectionId/documents/:documentId[?chunk=<chunkId>]`: metadata, normalised
 * full text (rendered as text, never as HTML) and chunks. `?chunk=` scrolls to and highlights a
 * chunk – used by chat (010) and playground (011) to link sources.
 */
@Component({
  selector: 'rl-document-detail-page',
  imports: [DatePipe, RouterLink, ConfirmDialog, DocumentStatusBadge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="rl-breadcrumb" aria-label="Breadcrumb">
      <ol>
        <li><a routerLink="/knowledge-bases">Knowledge Bases</a></li>
        <li>
          <a [routerLink]="['/knowledge-bases', collectionId()]">{{
            collection.hasValue() ? collection.value().name : 'Knowledge base'
          }}</a>
        </li>
        <li aria-current="page">
          {{ document.hasValue() ? document.value().filename : 'Document' }}
        </li>
      </ol>
    </nav>

    <p class="rl-visually-hidden" role="status" aria-live="polite">{{ announcement() }}</p>

    @if (document.isLoading() && !document.hasValue()) {
      <p role="status">Loading document…</p>
    } @else if (notFound()) {
      <h1>Document not found</h1>
      <p>It may have been deleted, or it belongs to another knowledge base.</p>
      <p><a [routerLink]="['/knowledge-bases', collectionId()]">Back to the knowledge base</a></p>
    } @else if (document.error(); as error) {
      <h1>Document</h1>
      <div class="rl-alert" role="alert">
        <p>
          <span aria-hidden="true">✕</span> The document could not be loaded. {{ error.message }}
        </p>
        <button type="button" class="rl-btn" (click)="document.reload()">Try again</button>
      </div>
    } @else if (document.hasValue()) {
      @let doc = document.value();
      <header class="rl-page-header">
        <div>
          <h1>{{ doc.filename }}</h1>
          @if (doc.metadata.title; as title) {
            <p class="rl-muted">Title: {{ title }}</p>
          }
        </div>
        <div class="rl-actions">
          @if (doc.status === 'failed') {
            <button type="button" class="rl-btn" [disabled]="busy()" (click)="reindex()">
              <span aria-hidden="true">↻</span> Reindex
            </button>
          }
          <button
            type="button"
            class="rl-btn rl-btn--danger"
            [disabled]="busy()"
            (click)="deleteOpen.set(true)"
          >
            Delete document
          </button>
        </div>
      </header>

      @if (actionError(); as message) {
        <div class="rl-alert" role="alert">
          <p><span aria-hidden="true">✕</span> {{ message }}</p>
        </div>
      }

      <section class="rl-card section" aria-labelledby="metadata-heading">
        <h2 id="metadata-heading">Metadata</h2>
        <dl class="rl-dl">
          <dt>Status</dt>
          <dd>
            <rl-document-status [status]="doc.status" />
            @if (isActive(doc.status)) {
              <span class="rl-muted"> – updating automatically</span>
            }
            @if (doc.errorMessage) {
              <p class="error-message">{{ doc.errorMessage }}</p>
            }
          </dd>
          <dt>Size</dt>
          <dd>{{ size(doc.sizeBytes) }} ({{ doc.sizeBytes }} bytes)</dd>
          <dt>MIME type</dt>
          <dd>
            <code>{{ doc.mimeType }}</code>
          </dd>
          <dt>Indexed chunks</dt>
          <dd>{{ doc.chunkCount }}</dd>
          <dt>SHA-256</dt>
          <dd>
            <code class="hash">{{ doc.contentSha256 }}</code>
          </dd>
          <dt>Uploaded</dt>
          <dd>
            <time [attr.datetime]="doc.createdAt">{{ doc.createdAt | date: 'medium' }}</time>
          </dd>
          <dt>Updated</dt>
          <dd>
            <time [attr.datetime]="doc.updatedAt">{{ doc.updatedAt | date: 'medium' }}</time>
          </dd>
        </dl>
      </section>

      <section class="rl-card section" aria-labelledby="content-heading">
        <h2 id="content-heading">Normalized full text</h2>
        <p class="rl-muted">
          The text as stored after normalization; chunk offsets refer to it. Shown as plain text.
        </p>
        @if (content.isLoading() && !content.hasValue()) {
          <p role="status">Loading text…</p>
        } @else if (content.error(); as error) {
          <div class="rl-alert" role="alert">
            <p>
              <span aria-hidden="true">✕</span> The text could not be loaded. {{ error.message }}
            </p>
            <button type="button" class="rl-btn" (click)="content.reload()">Try again</button>
          </div>
        } @else if (content.hasValue()) {
          <pre
            class="fulltext"
            tabindex="0"
            role="region"
            aria-label="Normalized full text"
            data-testid="fulltext"
            >{{ content.value().content }}</pre>
          <p class="rl-muted small">{{ content.value().content.length }} characters</p>
        }
      </section>

      <section class="section" aria-labelledby="chunks-heading">
        <h2 id="chunks-heading">Chunks</h2>
        @if (chunks.isLoading() && !chunks.hasValue()) {
          <p role="status">Loading chunks…</p>
        } @else if (chunks.error(); as error) {
          <div class="rl-alert" role="alert">
            <p>
              <span aria-hidden="true">✕</span> The chunks could not be loaded. {{ error.message }}
            </p>
            <button type="button" class="rl-btn" (click)="chunks.reload()">Try again</button>
          </div>
        } @else if (chunks.hasValue()) {
          @if (missingChunk()) {
            <div class="rl-alert rl-alert--warn" role="alert">
              <p>
                <span aria-hidden="true">⚠</span> The linked chunk does not exist in this document
                (anymore). Reindexing replaces chunks with new ones.
              </p>
            </div>
          }
          @let list = chunks.value().chunks;
          @if (list.length === 0) {
            <p class="rl-muted">
              @if (isActive(doc.status)) {
                No chunks yet – the document is still being processed.
              } @else {
                This document has no chunks.
              }
            </p>
          } @else {
            <p class="rl-muted">
              {{ count(list.length, 'chunk') }}, {{ embeddedCount() }} with embedding.
            </p>
            <ol class="chunks">
              @for (chunk of list; track chunk.id) {
                @let linked = chunk.id === chunkParam();
                <li
                  class="rl-card chunk"
                  tabindex="-1"
                  [id]="'chunk-' + chunk.id"
                  [attr.data-chunk-id]="chunk.id"
                  [attr.aria-current]="linked ? 'true' : null"
                  [attr.aria-labelledby]="'chunk-heading-' + chunk.id"
                  [class.is-linked]="linked"
                >
                  <div class="chunk__header">
                    <h3 [id]="'chunk-heading-' + chunk.id">Chunk #{{ chunk.chunkIndex }}</h3>
                    @if (chunk.hasEmbedding) {
                      <span class="rl-badge rl-badge--ok"
                        ><span aria-hidden="true">✓</span> Embedding stored</span
                      >
                    } @else {
                      <span class="rl-badge rl-badge--neutral"
                        ><span aria-hidden="true">–</span> No embedding</span
                      >
                    }
                    @if (linked) {
                      <span class="rl-badge rl-badge--info"
                        ><span aria-hidden="true">➜</span> Linked chunk</span
                      >
                    }
                    <a
                      class="chunk__link"
                      [routerLink]="[]"
                      [queryParams]="{ chunk: chunk.id }"
                      [attr.aria-label]="'Link to chunk #' + chunk.chunkIndex"
                      >Link</a
                    >
                  </div>
                  <dl class="rl-dl chunk__meta">
                    <dt>Offsets</dt>
                    <dd>{{ chunk.startOffset }}–{{ chunk.endOffset }}</dd>
                    <dt>Characters</dt>
                    <dd>
                      {{ chunk.charCount }}
                      @if (chunk.tokenEstimate !== null) {
                        <span class="rl-muted">(≈ {{ chunk.tokenEstimate }} tokens, estimate)</span>
                      }
                    </dd>
                    <dt>Heading path</dt>
                    <dd>
                      @if (chunk.headingPath.length > 0) {
                        {{ chunk.headingPath.join(' › ') }}
                      } @else {
                        <span class="rl-muted">none</span>
                      }
                    </dd>
                    @if (chunk.overlapChars > 0) {
                      <dt>Overlap</dt>
                      <dd>{{ chunk.overlapChars }} characters from the previous chunk</dd>
                    }
                  </dl>
                  <pre class="chunk__content">{{ chunk.content }}</pre>
                </li>
              }
            </ol>
          }
        }
      </section>

      <rl-confirm-dialog
        heading="Delete document?"
        [open]="deleteOpen()"
        [busy]="busy()"
        [error]="deleteError()"
        (confirmed)="delete()"
        (cancelled)="deleteOpen.set(false)"
      >
        <p>
          This permanently deletes “{{ doc.filename }}” and all of its chunks. This cannot be
          undone.
        </p>
      </rl-confirm-dialog>
    }
  `,
  styles: `
    .section {
      margin-bottom: 1.25rem;
    }
    .error-message {
      margin: 0.4rem 0 0;
      color: var(--rl-danger);
      max-width: 70ch;
    }
    .hash {
      overflow-wrap: anywhere;
    }
    pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      margin: 0;
    }
    .fulltext {
      max-height: 24rem;
      overflow: auto;
      padding: 0.75rem;
      background: var(--rl-surface-muted);
      border: 1px solid var(--rl-border);
      border-radius: 6px;
    }
    .small {
      font-size: 0.85rem;
      margin: 0.4rem 0 0;
    }
    .chunks {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 0.75rem;
    }
    .chunk {
      scroll-margin-top: 1rem;
    }
    .chunk.is-linked {
      border: 2px solid var(--rl-accent);
      box-shadow: 0 0 0 3px var(--rl-accent-soft);
    }
    .chunk__header {
      display: flex;
      gap: 0.6rem;
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: 0.5rem;
    }
    .chunk__header h3 {
      margin: 0;
      font-size: 1rem;
    }
    .chunk__link {
      margin-left: auto;
      font-size: 0.85rem;
    }
    .chunk__meta {
      font-size: 0.85rem;
      margin-bottom: 0.6rem;
    }
    .chunk__content {
      padding: 0.6rem;
      background: var(--rl-surface-muted);
      border-radius: 6px;
    }
  `,
})
export class DocumentDetailPage {
  readonly collectionId = input.required<string>();
  readonly documentId = input.required<string>();
  /** Query parameter `?chunk=<chunkId>`: chunk to scroll to and highlight. */
  readonly chunk = input<string | undefined>(undefined);

  private readonly api = inject(KnowledgeApi);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly size = formatBytes;
  protected readonly count = plural;
  protected readonly isActive = isActiveStatus;
  protected readonly chunkParam = computed(() => this.chunk() || undefined);

  protected readonly collection = rxResource({
    params: () => this.collectionId(),
    stream: ({ params }) => this.api.getCollection(params),
  });
  protected readonly document = rxResource({
    params: () => this.documentId(),
    stream: ({ params }) => this.api.getDocument(params),
  });
  protected readonly content = rxResource({
    params: () => this.documentId(),
    stream: ({ params }) => this.api.getDocumentContent(params),
  });
  protected readonly chunks = rxResource({
    params: () => this.documentId(),
    stream: ({ params }) => this.api.getDocumentChunks(params),
  });

  /** 404, or a document of another collection (the URL would lie about where it belongs). */
  protected readonly notFound = computed(() => {
    const error = this.document.error();
    if (error instanceof ApiRequestError && error.status === 404) {
      return true;
    }
    return this.document.hasValue() && this.document.value().collectionId !== this.collectionId();
  });

  protected readonly embeddedCount = computed(() =>
    this.chunks.hasValue() ? this.chunks.value().chunks.filter((c) => c.hasEmbedding).length : 0,
  );

  protected readonly missingChunk = computed(() => {
    const id = this.chunkParam();
    return (
      id !== undefined &&
      this.chunks.hasValue() &&
      !this.chunks.value().chunks.some((chunk) => chunk.id === id)
    );
  });

  protected readonly announcement = signal('');
  protected readonly busy = signal(false);
  protected readonly actionError = signal<string | undefined>(undefined);
  protected readonly deleteOpen = signal(false);
  protected readonly deleteError = signal<string | undefined>(undefined);

  /** The chunk id the view was last scrolled to (scroll once per link, not on every poll). */
  private scrolledTo: string | undefined;

  constructor() {
    pollWhile(
      () =>
        !this.document.isLoading() &&
        this.document.hasValue() &&
        isActiveStatus(this.document.value().status),
      () => this.document.reload(),
    );

    // When processing finishes, chunks (and their embeddings) have changed.
    let previous: DocumentStatus | undefined;
    effect(() => {
      if (!this.document.hasValue()) {
        return;
      }
      const { status, filename } = this.document.value();
      const before = previous;
      previous = status;
      if (before !== undefined && before !== status) {
        untracked(() => {
          this.announcement.set(`“${filename}”: ${status}.`);
          if (!isActiveStatus(status)) {
            this.chunks.reload();
          }
        });
      }
    });

    afterRenderEffect(() => {
      const id = this.chunkParam();
      if (id === undefined || !this.chunks.hasValue() || id === this.scrolledTo) {
        return;
      }
      const element = Array.from(
        this.host.nativeElement.querySelectorAll<HTMLElement>('[data-chunk-id]'),
      ).find((candidate) => candidate.dataset['chunkId'] === id);
      if (!element) {
        return;
      }
      this.scrolledTo = id;
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      element.scrollIntoView?.({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
      element.focus({ preventScroll: true });
    });
  }

  protected async reindex(): Promise<void> {
    this.busy.set(true);
    this.actionError.set(undefined);
    try {
      const updated = await firstValueFrom(this.api.reindexDocument(this.documentId()));
      this.document.set(updated);
      this.announcement.set('Queued for reindexing.');
    } catch (error) {
      this.actionError.set(`Reindexing failed: ${toApiRequestError(error).message}`);
    } finally {
      this.busy.set(false);
    }
  }

  protected async delete(): Promise<void> {
    this.busy.set(true);
    this.deleteError.set(undefined);
    try {
      await firstValueFrom(this.api.deleteDocument(this.documentId()), { defaultValue: undefined });
      this.deleteOpen.set(false);
      await this.router.navigate(['/knowledge-bases', this.collectionId()]);
    } catch (error) {
      this.deleteError.set(toApiRequestError(error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
