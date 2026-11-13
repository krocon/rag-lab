import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { PlaygroundResult } from '@raglab/shared';
import { formatSourceLocation, isCodeLanguage } from '../../core/util/source-location';
import { ExternalLink } from '../../shared/ui/external-link';

export type ChatContextStatus = 'included' | 'below-min-score' | 'outside-budget';

/** What chat would do with a result; `belowMinScore` wins over the budget. */
export function chatContextStatus(result: PlaygroundResult): ChatContextStatus {
  if (result.includedInChatContext) {
    return 'included';
  }
  return result.belowMinScore ? 'below-min-score' : 'outside-budget';
}

/** Width of the score bar in percent: score 0..1 → 0..100 (negative scores show no bar). */
export function scoreBarPercent(score: number): number {
  return Math.round(Math.min(1, Math.max(0, score)) * 1000) / 10;
}

/**
 * Ranked results as a semantic table: rank, score (number + bar), distance, source (`path:lines`,
 * language, symbol or heading path), chunk and what chat would do with it. Each row expands to
 * exactly what was embedded – the embedded header (if any) and the chunk text, rendered as text
 * only – its offsets, a deep link to the chunk in the document view and, for repository imports,
 * a link to the lines at the imported commit.
 */
@Component({
  selector: 'rl-playground-results',
  imports: [RouterLink, ExternalLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p id="pg-score-help" class="help">
      <strong>score</strong> = 1 − cosine distance, higher is more similar (−1 to 1; the bar shows 0
      to 1). <strong>distance</strong> = cosine distance from pgvector <code>&lt;=&gt;</code>, lower
      is more similar (0 to 2). Scores rank chunks for this query; they are not a confidence and are
      not comparable across embedding models.
    </p>
    <div class="rl-table-wrap" tabindex="0" role="region" aria-label="Results table">
      <table class="rl-table" aria-describedby="pg-score-help">
        <caption>
          Top
          {{
            results().length
          }}
          chunks by ascending distance
        </caption>
        <thead>
          <tr>
            <th scope="col" class="num">Rank</th>
            <th scope="col">Score</th>
            <th scope="col" class="num">Distance</th>
            <th scope="col">Source</th>
            <th scope="col" class="num">Chunk</th>
            <th scope="col">Chat context</th>
            <th scope="col"><span class="rl-visually-hidden">Details</span></th>
          </tr>
        </thead>
        <tbody>
          @for (result of results(); track result.chunkId) {
            @let open = expanded().has(result.chunkId);
            @let status = statusOf(result);
            <tr [class.is-open]="open" [attr.data-rank]="result.rank">
              <td class="num">{{ result.rank }}</td>
              <td>
                <span class="score">
                  <span class="score__value">{{ result.score.toFixed(3) }}</span>
                  <span class="score__bar" aria-hidden="true"
                    ><span [style.width.%]="barPercent(result.score)"></span
                  ></span>
                </span>
              </td>
              <td class="num">{{ result.distance.toFixed(3) }}</td>
              <th scope="row" class="source">
                <span class="source__file">{{ location(result) }}</span>
                <span class="source__path">
                  <span class="source__lang">{{ result.language }}</span>
                  @if (result.symbol) {
                    · <code>{{ result.symbol }}</code>
                  } @else if (result.headingPath.length > 0 && !isCode(result.language)) {
                    · {{ result.headingPath.join(' › ') }}
                  }
                </span>
              </th>
              <td class="num">#{{ result.chunkIndex }}</td>
              <td>
                @switch (status) {
                  @case ('included') {
                    <span class="rl-badge rl-badge--ok"
                      ><span aria-hidden="true">✓</span> In chat context</span
                    >
                  }
                  @case ('below-min-score') {
                    <span class="rl-badge rl-badge--neutral"
                      ><span aria-hidden="true">↓</span> Below minScore</span
                    >
                  }
                  @default {
                    <span class="rl-badge rl-badge--warn"
                      ><span aria-hidden="true">✂</span> Outside budget</span
                    >
                  }
                }
              </td>
              <td>
                <button
                  type="button"
                  class="rl-btn rl-btn--small"
                  [attr.aria-expanded]="open"
                  [attr.aria-controls]="detailId(result)"
                  [attr.aria-label]="
                    (open ? 'Hide' : 'Show') +
                    ' chunk of rank ' +
                    result.rank +
                    ', ' +
                    result.filename
                  "
                  (click)="toggle(result.chunkId)"
                >
                  {{ open ? 'Hide' : 'Show' }}
                </button>
              </td>
            </tr>
            @if (open) {
              <tr class="detail" [id]="detailId(result)">
                <td colspan="7">
                  <dl class="rl-dl meta">
                    <dt>Offsets</dt>
                    <dd>
                      {{ result.startOffset }}–{{ result.endOffset }}
                      <span class="rl-muted">(characters in the normalized document text)</span>
                    </dd>
                    <dt>Chunk id</dt>
                    <dd>
                      <code>{{ result.chunkId }}</code>
                    </dd>
                  </dl>
                  @if (result.embeddingHeader !== null) {
                    <p class="part-label" [id]="detailId(result) + '-header'">
                      Embedded header
                      <span class="rl-muted">(embedded in front of the chunk text)</span>
                    </p>
                    <pre
                      class="excerpt excerpt--header"
                      data-testid="embedding-header"
                      [attr.aria-labelledby]="detailId(result) + '-header'"
                      >{{ result.embeddingHeader }}</pre>
                    <p class="part-label">Chunk text</p>
                  }
                  @let code = isCode(result.language);
                  <p class="excerpt" [class.excerpt--code]="code">{{ result.content }}</p>
                  <a
                    [routerLink]="[
                      '/knowledge-bases',
                      collectionId(),
                      'documents',
                      result.documentId,
                    ]"
                    [queryParams]="{ chunk: result.chunkId }"
                    >Open chunk in {{ result.filename }} <span aria-hidden="true">→</span></a
                  >
                  @if (result.sourceUrl) {
                    <span class="external"><rl-external-link [url]="result.sourceUrl" /></span>
                  }
                </td>
              </tr>
            }
          }
        </tbody>
      </table>
    </div>
  `,
  styles: `
    .help {
      font-size: 0.88rem;
      color: var(--rl-text-muted);
      max-width: 90ch;
    }
    .score {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      font-variant-numeric: tabular-nums;
    }
    .score__bar {
      display: inline-block;
      width: 5rem;
      height: 0.6rem;
      border: 1px solid var(--rl-border-strong);
      border-radius: 999px;
      overflow: hidden;
      background: var(--rl-surface-muted);
    }
    .score__bar > span {
      display: block;
      height: 100%;
      background: var(--rl-accent);
    }
    .source {
      font-weight: 400;
      font-size: 0.92rem;
      text-transform: none;
      letter-spacing: normal;
      color: var(--rl-text);
      overflow-wrap: break-word;
      min-width: 9rem;
    }
    td .rl-badge {
      white-space: nowrap;
    }
    .source__file {
      display: block;
      font-weight: 600;
    }
    .source__path {
      display: block;
      font-size: 0.85rem;
      color: var(--rl-text-muted);
    }
    tr.is-open > td,
    tr.is-open > th {
      border-bottom: none;
    }
    .detail td {
      background: var(--rl-surface-muted);
    }
    .meta {
      font-size: 0.85rem;
      margin-bottom: 0.5rem;
    }
    .excerpt {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 0.9rem;
      padding: 0.6rem;
      background: var(--rl-surface);
      border: 1px solid var(--rl-border);
      border-radius: 6px;
      max-height: 24rem;
      overflow-y: auto;
      margin: 0 0 0.5rem;
    }
    .excerpt--code,
    .excerpt--header {
      font-family: var(--rl-mono);
      font-size: 0.85rem;
    }
    .excerpt--header {
      border-style: dashed;
    }
    .part-label {
      margin: 0 0 0.25rem;
      font-size: 0.85rem;
      font-weight: 600;
    }
    .source__file {
      overflow-wrap: anywhere;
    }
    .external {
      margin-left: 1rem;
    }
  `,
})
export class PlaygroundResults {
  readonly results = input.required<readonly PlaygroundResult[]>();
  readonly collectionId = input.required<string>();

  protected readonly expanded = signal<ReadonlySet<string>>(new Set());
  protected readonly statusOf = chatContextStatus;
  protected readonly barPercent = scoreBarPercent;
  protected readonly location = formatSourceLocation;
  protected readonly isCode = isCodeLanguage;

  /** Ids of results that are shown, so new results start collapsed. */
  private readonly ids = computed(() => new Set(this.results().map((result) => result.chunkId)));

  protected detailId(result: PlaygroundResult): string {
    return `pg-chunk-${result.chunkId}`;
  }

  protected toggle(chunkId: string): void {
    const ids = this.ids();
    this.expanded.update((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)));
      if (next.has(chunkId)) {
        next.delete(chunkId);
      } else {
        next.add(chunkId);
      }
      return next;
    });
  }
}
