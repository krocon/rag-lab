import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { DocumentDto } from '@raglab/shared';
import { formatBytes } from '../../core/util/format';
import { DocumentStatusBadge } from './document-status';

/**
 * Documents of a collection as a semantic table (path, falling back to the file name for uploads
 * without a path, and language); actions are handled by the page.
 */
@Component({
  selector: 'rl-document-table',
  imports: [DatePipe, RouterLink, DocumentStatusBadge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rl-table-wrap">
      <table class="rl-table">
        <caption>
          {{
            caption()
          }}
        </caption>
        <thead>
          <tr>
            <th scope="col">Path</th>
            <th scope="col">Language</th>
            <th scope="col" class="num">Size</th>
            <th scope="col">Status</th>
            <th scope="col" class="num">Chunks</th>
            <th scope="col">Uploaded</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          @for (document of documents(); track document.id) {
            <tr [attr.data-document-id]="document.id">
              <th scope="row" class="filename">
                <a
                  [routerLink]="[
                    '/knowledge-bases',
                    document.collectionId,
                    'documents',
                    document.id,
                  ]"
                >
                  {{ document.path || document.filename }}
                </a>
              </th>
              <td>{{ document.language }}</td>
              <td class="num">{{ size(document.sizeBytes) }}</td>
              <td>
                <rl-document-status [status]="document.status" />
                @if (document.status === 'failed' && document.errorMessage) {
                  <p class="doc-error" [id]="'doc-error-' + document.id">
                    {{ document.errorMessage }}
                  </p>
                }
              </td>
              <td class="num">{{ document.chunkCount }}</td>
              <td>
                <time [attr.datetime]="document.createdAt">{{
                  document.createdAt | date: 'medium'
                }}</time>
              </td>
              <td>
                <div class="rl-actions">
                  @if (document.status === 'failed') {
                    <button
                      type="button"
                      class="rl-btn rl-btn--small"
                      [disabled]="busyIds().has(document.id)"
                      [attr.aria-describedby]="
                        document.errorMessage ? 'doc-error-' + document.id : null
                      "
                      (click)="reindex.emit(document)"
                    >
                      <span aria-hidden="true">↻</span> Reindex
                      <span class="rl-visually-hidden">{{ document.filename }}</span>
                    </button>
                  }
                  <button
                    type="button"
                    class="rl-btn rl-btn--small"
                    [disabled]="busyIds().has(document.id)"
                    (click)="remove.emit(document)"
                  >
                    Delete
                    <span class="rl-visually-hidden">{{ document.filename }}</span>
                  </button>
                </div>
              </td>
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
  styles: `
    .filename {
      font-weight: 600;
      text-transform: none;
      letter-spacing: normal;
      font-size: 0.92rem;
      color: var(--rl-text);
      overflow-wrap: anywhere;
      min-width: 10rem;
      font-family: var(--rl-mono);
    }
    .doc-error {
      margin: 0.4rem 0 0;
      font-size: 0.85rem;
      color: var(--rl-danger);
      max-width: 40ch;
      overflow-wrap: anywhere;
    }
    td {
      white-space: nowrap;
    }
    td:nth-child(4) {
      white-space: normal;
    }
  `,
})
export class DocumentTable {
  readonly documents = input.required<readonly DocumentDto[]>();
  readonly caption = input('Documents');
  /** Documents with an action in progress (buttons disabled). */
  readonly busyIds = input<ReadonlySet<string>>(new Set());

  readonly reindex = output<DocumentDto>();
  readonly remove = output<DocumentDto>();

  protected readonly size = formatBytes;
}
