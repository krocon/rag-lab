import { HttpEventType } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import type { DocumentDto, SystemInfoResponse } from '@raglab/shared';
import type { Subscription } from 'rxjs';
import { type ApiRequestError, toApiRequestError } from '../../core/api/api-error';
import { KnowledgeApi } from '../../core/api/knowledge-api';
import { fileExtension, formatBytes } from '../../core/util/format';

type UploadState = 'rejected' | 'queued' | 'uploading' | 'done' | 'failed';

export interface UploadItem {
  key: number;
  file: File;
  state: UploadState;
  /** 0–100 while uploading; `null` when the browser does not know the total size. */
  progress: number | null;
  message?: string;
  /** `409 DUPLICATE_DOCUMENT`: the document that already has this content. */
  existingDocumentId?: string;
}

const STATE_LABEL: Record<UploadState, { icon: string; label: string; tone: string }> = {
  rejected: { icon: '✕', label: 'Not uploaded', tone: 'danger' },
  queued: { icon: '◷', label: 'Queued', tone: 'neutral' },
  uploading: { icon: '⇡', label: 'Uploading', tone: 'info' },
  done: { icon: '✓', label: 'Uploaded', tone: 'ok' },
  failed: { icon: '✕', label: 'Upload failed', tone: 'danger' },
};

/**
 * File picker + drag & drop for Markdown/text files. Files are checked against the limits of
 * `/api/system/info` first and then uploaded one per request, so progress and server errors
 * (`413`, `415`, `409`, …) are reported per file and one bad file does not block the others.
 */
@Component({
  selector: 'rl-document-upload',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="dropzone"
      [class.is-dragging]="dragging()"
      (dragenter)="onDragOver($event)"
      (dragover)="onDragOver($event)"
      (dragleave)="dragging.set(false)"
      (drop)="onDrop($event)"
      data-testid="dropzone"
    >
      <p class="dropzone__title">
        <span aria-hidden="true">⇪</span>
        {{ dragging() ? 'Drop files to upload' : 'Drag files here or' }}
        <button
          #chooseButton
          type="button"
          class="rl-btn rl-btn--primary"
          [attr.aria-describedby]="limitsId"
          (click)="fileInput.click()"
        >
          Choose files…
        </button>
      </p>
      <input
        #fileInput
        type="file"
        multiple
        hidden
        [attr.accept]="accept()"
        (change)="onFilesSelected($event)"
        data-testid="file-input"
      />
      <p class="rl-muted limits" [id]="limitsId">{{ limitsText() }}</p>
    </div>

    <p class="rl-visually-hidden" role="status" aria-live="polite">{{ announcement() }}</p>

    @if (items().length > 0) {
      <ul class="uploads" aria-label="Uploads">
        @for (item of items(); track item.key) {
          <li class="upload" [attr.data-upload-state]="item.state">
            <span class="upload__name">{{ item.file.name }}</span>
            <span class="rl-muted upload__size">{{ size(item.file.size) }}</span>
            <span class="rl-badge rl-badge--{{ stateLabel[item.state].tone }}">
              <span aria-hidden="true">{{ stateLabel[item.state].icon }}</span>
              {{ stateLabel[item.state].label }}
            </span>
            @if (item.state === 'uploading') {
              <progress
                max="100"
                [attr.value]="item.progress"
                [attr.aria-label]="'Upload progress of ' + item.file.name"
              ></progress>
              <span class="rl-muted">{{
                item.progress === null ? 'Uploading…' : item.progress + ' %'
              }}</span>
            }
            @if (item.message) {
              <p class="upload__message" [class.is-error]="isError(item)">
                {{ item.message }}
                @if (item.existingDocumentId) {
                  <a
                    [routerLink]="[
                      '/knowledge-bases',
                      collectionId(),
                      'documents',
                      item.existingDocumentId,
                    ]"
                    >Open the existing document</a
                  >
                }
              </p>
            }
          </li>
        }
      </ul>
      @if (finishedCount() > 0) {
        <button type="button" class="rl-btn rl-btn--small" (click)="clearFinished()">
          Clear finished uploads
        </button>
      }
    }
  `,
  styles: `
    .dropzone {
      border: 2px dashed var(--rl-border-strong);
      border-radius: var(--rl-radius);
      padding: 1rem;
      text-align: center;
    }
    .dropzone.is-dragging {
      border-style: solid;
      border-color: var(--rl-accent);
      background: var(--rl-accent-soft);
    }
    .dropzone__title {
      display: flex;
      gap: 0.6rem;
      align-items: center;
      justify-content: center;
      flex-wrap: wrap;
      font-weight: 600;
    }
    .limits {
      font-size: 0.85rem;
      margin: 0;
    }
    .uploads {
      list-style: none;
      padding: 0;
      margin: 1rem 0 0.75rem;
      display: grid;
      gap: 0.5rem;
    }
    .upload {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem 0.75rem;
      align-items: center;
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--rl-border);
      border-radius: 6px;
    }
    .upload__name {
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .upload__size {
      font-size: 0.85rem;
    }
    .upload__message {
      flex-basis: 100%;
      margin: 0;
      font-size: 0.9rem;
      overflow-wrap: anywhere;
    }
    .upload__message.is-error {
      color: var(--rl-danger);
    }
  `,
})
export class DocumentUpload {
  private static nextKey = 0;
  private static nextId = 0;

  readonly collectionId = input.required<string>();
  /** Emits the stored (`pending`) document after each successful upload. */
  readonly uploaded = output<DocumentDto>();

  private readonly api = inject(KnowledgeApi);
  protected readonly stateLabel = STATE_LABEL;
  protected readonly size = formatBytes;
  protected readonly limitsId = `rl-upload-limits-${DocumentUpload.nextId++}`;

  /** Upload limits; optional – without them the server is the only check. */
  private readonly systemInfo = rxResource({ stream: () => this.api.getSystemInfo() });
  private readonly limits = computed<SystemInfoResponse['upload'] | undefined>(() =>
    this.systemInfo.hasValue() ? this.systemInfo.value().upload : undefined,
  );

  protected readonly accept = computed(() => this.limits()?.allowedExtensions.join(',') ?? null);
  protected readonly limitsText = computed(() => {
    const limits = this.limits();
    if (limits) {
      return `Markdown or text files (${limits.allowedExtensions.join(', ')}), UTF-8, up to ${formatBytes(limits.maxFileBytes)} each. Each file is uploaded on its own.`;
    }
    if (this.systemInfo.isLoading()) {
      return 'Loading upload limits…';
    }
    return 'Upload limits could not be loaded; the server checks every file.';
  });

  protected readonly items = signal<UploadItem[]>([]);
  protected readonly dragging = signal(false);
  protected readonly announcement = signal('');
  protected readonly finishedCount = computed(
    () => this.items().filter((item) => !['queued', 'uploading'].includes(item.state)).length,
  );

  private readonly chooseButton = viewChild.required<ElementRef<HTMLButtonElement>>('chooseButton');
  private current: Subscription | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.current?.unsubscribe());
  }

  /** Adds files to the queue (rejected ones stay visible with the reason) and starts uploading. */
  addFiles(files: Iterable<File>): void {
    const added = [...files].map((file) => this.precheck(file));
    if (added.length === 0) {
      return;
    }
    this.items.update((items) => [...items, ...added]);
    const rejected = added.filter((item) => item.state === 'rejected');
    if (rejected.length > 0) {
      this.announce(rejected.map((item) => item.message).join(' '));
    }
    this.processNext();
  }

  protected onFilesSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.addFiles(Array.from(input.files ?? []));
    // Allows choosing the same file again (e.g. after fixing it).
    input.value = '';
  }

  protected onDragOver(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes('Files')) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    this.dragging.set(true);
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    this.addFiles(Array.from(event.dataTransfer?.files ?? []));
  }

  protected clearFinished(): void {
    this.items.update((items) =>
      items.filter((item) => item.state === 'queued' || item.state === 'uploading'),
    );
    this.chooseButton().nativeElement.focus();
  }

  protected isError(item: UploadItem): boolean {
    return item.state === 'failed' || item.state === 'rejected';
  }

  private precheck(file: File): UploadItem {
    const item: UploadItem = { key: DocumentUpload.nextKey++, file, state: 'queued', progress: 0 };
    const limits = this.limits();
    const reject = (message: string): UploadItem => ({ ...item, state: 'rejected', message });
    if (limits && !limits.allowedExtensions.includes(fileExtension(file.name))) {
      return reject(
        `"${file.name}" is not a supported file type. Allowed: ${limits.allowedExtensions.join(', ')}.`,
      );
    }
    if (limits && file.size > limits.maxFileBytes) {
      return reject(
        `"${file.name}" is ${formatBytes(file.size)}; the limit is ${formatBytes(limits.maxFileBytes)} per file.`,
      );
    }
    if (file.size === 0) {
      return reject(`"${file.name}" is empty.`);
    }
    return item;
  }

  /** Uploads queued files one after another. */
  private processNext(): void {
    if (this.current && !this.current.closed) {
      return;
    }
    const next = this.items().find((item) => item.state === 'queued');
    if (!next) {
      return;
    }
    this.patch(next.key, { state: 'uploading', progress: 0 });
    this.current = this.api.uploadDocuments(this.collectionId(), [next.file]).subscribe({
      next: (event) => {
        if (event.type === HttpEventType.UploadProgress) {
          const progress = event.total ? Math.round((event.loaded / event.total) * 100) : null;
          this.patch(next.key, { progress });
        } else if (event.type === HttpEventType.Response) {
          const document = event.body?.documents[0];
          this.patch(next.key, {
            state: 'done',
            progress: 100,
            message: 'Uploaded – indexing has started.',
          });
          this.announce(`"${next.file.name}" uploaded; indexing has started.`);
          if (document) {
            this.uploaded.emit(document);
          }
        }
      },
      error: (error: unknown) => {
        const apiError = toApiRequestError(error);
        const message = uploadErrorMessage(next.file.name, apiError);
        this.patch(next.key, {
          state: 'failed',
          message,
          existingDocumentId: apiError.detail('existingDocumentId'),
        });
        this.announce(message);
        this.current = undefined;
        this.processNext();
      },
      complete: () => {
        this.current = undefined;
        this.processNext();
      },
    });
  }

  private patch(key: number, changes: Partial<UploadItem>): void {
    this.items.update((items) =>
      items.map((item) => (item.key === key ? { ...item, ...changes } : item)),
    );
  }

  private announce(message: string): void {
    this.announcement.set(message);
  }
}

/** Per-file message for a failed upload; the API's messages already name the file. */
export function uploadErrorMessage(filename: string, error: ApiRequestError): string {
  switch (error.code) {
    case 'DUPLICATE_DOCUMENT':
      return error.detail('existingDocumentId')
        ? `"${filename}" has the same content as a document that is already in this knowledge base.`
        : error.message;
    case 'FILE_TOO_LARGE':
    case 'UNSUPPORTED_FILE_TYPE':
    case 'EMPTY_DOCUMENT':
    case 'INVALID_ENCODING':
      return error.message;
    case 'COLLECTION_NOT_FOUND':
      return 'This knowledge base no longer exists.';
    default:
      return `"${filename}" could not be uploaded: ${error.message}`;
  }
}
