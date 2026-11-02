import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { DocumentStatus } from '@raglab/shared';

interface StatusPresentation {
  label: string;
  icon: string;
  tone: 'neutral' | 'info' | 'ok' | 'danger';
  description: string;
}

export const DOCUMENT_STATUS_PRESENTATION: Record<DocumentStatus, StatusPresentation> = {
  pending: {
    label: 'Pending',
    icon: '◷',
    tone: 'neutral',
    description: 'Waiting to be processed',
  },
  processing: {
    label: 'Processing',
    icon: '⟳',
    tone: 'info',
    description: 'Chunking and embedding',
  },
  ready: { label: 'Ready', icon: '✓', tone: 'ok', description: 'Chunked and embedded' },
  failed: { label: 'Failed', icon: '✕', tone: 'danger', description: 'Processing failed' },
};

/** Document status as icon + text badge (never color alone). */
@Component({
  selector: 'rl-document-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      class="rl-badge rl-badge--{{ presentation().tone }}"
      [attr.title]="presentation().description"
      data-testid="document-status"
    >
      <span aria-hidden="true">{{ presentation().icon }}</span>
      {{ presentation().label }}
    </span>
  `,
})
export class DocumentStatusBadge {
  readonly status = input.required<DocumentStatus>();
  protected readonly presentation = computed(() => DOCUMENT_STATUS_PRESENTATION[this.status()]);
}

export function isActiveStatus(status: DocumentStatus): boolean {
  return status === 'pending' || status === 'processing';
}
