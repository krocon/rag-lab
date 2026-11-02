import { HttpErrorResponse, httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed } from '@angular/core';
import type { ComponentStatus, LivenessResponse, ReadinessResponse } from '@raglab/shared';
import { API_PATHS } from '../../core/api/api-paths';

type Tone = 'ok' | 'danger' | 'neutral';

interface StatusRow {
  label: string;
  tone: Tone;
  text: string;
  detail?: string;
}

/** Live status of API, database and pgvector from the health endpoints. */
@Component({
  selector: 'rl-system-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="rl-card" aria-labelledby="system-status-heading">
      <div class="status__header">
        <h2 id="system-status-heading">System status</h2>
        <button type="button" class="rl-btn" (click)="refresh()" [disabled]="loading()">
          <span aria-hidden="true">↻</span> Refresh
        </button>
      </div>
      <ul class="status__list" aria-live="polite" [attr.aria-busy]="loading()">
        @for (row of rows(); track row.label) {
          <li class="status__row">
            <span class="status__label">{{ row.label }}</span>
            <span
              class="rl-badge rl-badge--{{ row.tone }}"
              [attr.data-testid]="'status-' + row.label"
            >
              <span aria-hidden="true">{{ icons[row.tone] }}</span>
              {{ row.text }}
            </span>
            @if (row.detail) {
              <span class="status__detail rl-muted">{{ row.detail }}</span>
            }
          </li>
        }
      </ul>
      @if (apiUnreachable()) {
        <p class="status__hint">
          The API is not reachable. Start it with <code>pnpm dev:api</code> (see README → Quick
          start).
        </p>
      } @else if (notReady()) {
        <p class="status__hint">
          Start the database with <code>pnpm db:up</code> and apply migrations with
          <code>pnpm db:migrate</code>.
        </p>
      }
    </section>
  `,
  styles: `
    .status__header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      margin-bottom: 0.75rem;
    }
    .status__list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 0.6rem;
    }
    .status__row {
      display: grid;
      grid-template-columns: 8rem auto 1fr;
      align-items: center;
      gap: 0.75rem;
    }
    .status__label {
      font-weight: 600;
    }
    .status__detail {
      font-size: 0.85rem;
      overflow-wrap: anywhere;
    }
    .status__hint {
      margin: 1rem 0 0;
    }
  `,
})
export class SystemStatus {
  protected readonly icons: Record<Tone, string> = { ok: '✓', danger: '✕', neutral: '…' };

  private readonly liveness = httpResource<LivenessResponse>(() => API_PATHS.health);
  private readonly readiness = httpResource<ReadinessResponse>(() => API_PATHS.readiness);

  protected readonly loading = computed(
    () => this.liveness.isLoading() || this.readiness.isLoading(),
  );

  protected readonly apiUnreachable = computed(
    () => !this.liveness.isLoading() && this.liveness.error() !== undefined,
  );

  /** The readiness endpoint answers 503 *with* a body; Angular reports it as an error. */
  private readonly readinessBody = computed<ReadinessResponse | undefined>(() => {
    if (this.readiness.hasValue()) {
      return this.readiness.value();
    }
    const error = this.readiness.error();
    if (error instanceof HttpErrorResponse && error.status === 503 && isReadiness(error.error)) {
      return error.error;
    }
    return undefined;
  });

  protected readonly notReady = computed(() => this.readinessBody()?.status === 'not_ready');

  protected readonly rows = computed<StatusRow[]>(() => {
    if (this.loading()) {
      return ['API', 'Database', 'pgvector'].map((label) => ({
        label,
        tone: 'neutral',
        text: 'Checking…',
      }));
    }
    const live = this.liveness.hasValue() ? this.liveness.value() : undefined;
    const api: StatusRow = live
      ? { label: 'API', tone: 'ok', text: 'Running', detail: `v${live.version}` }
      : { label: 'API', tone: 'danger', text: 'Unreachable' };

    const body = this.readinessBody();
    if (!body) {
      return [
        api,
        { label: 'Database', tone: 'neutral', text: 'Unknown' },
        { label: 'pgvector', tone: 'neutral', text: 'Unknown' },
      ];
    }
    const { database, pgvector } = body.checks;
    return [
      api,
      componentRow(
        'Database',
        database.status,
        database.error ??
          (database.latencyMs !== undefined ? `${database.latencyMs} ms` : undefined),
      ),
      componentRow(
        'pgvector',
        pgvector.status,
        pgvector.error ?? (pgvector.version ? `v${pgvector.version}` : undefined),
      ),
    ];
  });

  protected refresh(): void {
    this.liveness.reload();
    this.readiness.reload();
  }
}

function componentRow(label: string, status: ComponentStatus, detail?: string): StatusRow {
  const row: StatusRow =
    status === 'up' ? { label, tone: 'ok', text: 'Up' } : { label, tone: 'danger', text: 'Down' };
  return detail ? { ...row, detail } : row;
}

function isReadiness(value: unknown): value is ReadinessResponse {
  return typeof value === 'object' && value !== null && 'checks' in value && 'status' in value;
}
