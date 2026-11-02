import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { EmbeddingModelInfo, PlaygroundSearchResponse } from '@raglab/shared';

/** `ollama · nomic-embed-text · 768 dimensions`. */
export function describeModel(model: EmbeddingModelInfo): string {
  return `${model.provider} · ${model.model} · ${model.dimensions} dimensions`;
}

/**
 * Diagnostics of one playground search: warnings, embedding models, index statistics, search
 * settings, chat context budget and timings. Warnings combine icon and text, never color alone.
 */
@Component({
  selector: 'rl-playground-diagnostics',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let r = response();
    <section class="rl-card diag" aria-labelledby="pg-diag-heading">
      <h2 id="pg-diag-heading">Diagnostics</h2>

      @if (r.warnings.length > 0) {
        <div class="rl-alert rl-alert--warn" role="status">
          <p class="warn-title"><span aria-hidden="true">⚠</span> Warnings</p>
          <ul class="warnings">
            @for (warning of r.warnings; track warning.code) {
              <li [attr.data-code]="warning.code">{{ warning.message }}</li>
            }
          </ul>
        </div>
      } @else {
        <p class="ok"><span aria-hidden="true">✓</span> No problems found.</p>
      }

      <h3>Embedding</h3>
      <dl class="rl-dl">
        <dt>Collection</dt>
        <dd>{{ model(r.embedding.collection) }}</dd>
        <dt>Query (configured)</dt>
        <dd>{{ model(r.embedding.provider) }}</dd>
        <dt>Match</dt>
        <dd>
          @if (r.embedding.matches) {
            <span class="rl-badge rl-badge--ok"><span aria-hidden="true">✓</span> Same model</span>
          } @else {
            <span class="rl-badge rl-badge--danger"
              ><span aria-hidden="true">✕</span> Different models</span
            >
          }
        </dd>
      </dl>

      <h3>Index</h3>
      <dl class="rl-dl">
        <dt>Documents</dt>
        <dd>
          {{ r.stats.documentCount }}
          <span class="rl-muted"
            >({{ r.stats.documentsByStatus.ready }} ready,
            {{ r.stats.documentsByStatus.pending }} pending,
            {{ r.stats.documentsByStatus.processing }} processing,
            {{ r.stats.documentsByStatus.failed }} failed)</span
          >
        </dd>
        <dt>Chunks</dt>
        <dd>{{ r.stats.chunkCount }}</dd>
        <dt>Searchable chunks</dt>
        <dd>{{ r.stats.searchableChunkCount }}</dd>
        <dt>Without embedding</dt>
        <dd>{{ r.stats.chunksWithoutEmbedding }}</dd>
      </dl>

      <h3>Search</h3>
      <dl class="rl-dl">
        <dt>Metric</dt>
        <dd>
          {{ r.search.metric }} distance (<code>{{ r.search.operator }}</code
          >)
        </dd>
        <dt>top-K</dt>
        <dd>{{ r.search.topK }}</dd>
        <dt>minScore</dt>
        <dd>{{ r.search.minScore ?? 'none' }}</dd>
        <dt>HNSW</dt>
        <dd>
          <code>iterative_scan = {{ r.search.iterativeScan }}</code
          >,
          <code>ef_search = {{ r.search.efSearch }}</code>
        </dd>
      </dl>

      <h3>Chat context</h3>
      <dl class="rl-dl">
        <dt>Sources sent</dt>
        <dd>{{ r.chatContext.includedCount }} of {{ r.results.length }}</dd>
        <dt>Budget used</dt>
        <dd>
          {{ r.chatContext.usedChars }} of {{ r.chatContext.charBudget }} characters
          <span class="rl-muted">(CHAT_CONTEXT_CHAR_BUDGET)</span>
        </dd>
        <dt>Outside budget</dt>
        <dd>{{ r.chatContext.omittedByBudgetCount }}</dd>
        <dt>Below minScore</dt>
        <dd>{{ r.chatContext.belowMinScoreCount }}</dd>
      </dl>

      <h3>Timings</h3>
      <dl class="rl-dl">
        <dt>Embedding</dt>
        <dd>{{ r.timings.embeddingMs }} ms</dd>
        <dt>Vector search</dt>
        <dd>{{ r.timings.searchMs }} ms</dd>
      </dl>
    </section>
  `,
  styles: `
    h3 {
      font-size: 0.95rem;
      margin: 1rem 0 0.4rem;
    }
    .rl-dl {
      font-size: 0.9rem;
      grid-template-columns: minmax(7rem, max-content) 1fr;
    }
    .warn-title {
      font-weight: 600;
      margin-bottom: 0.25rem;
    }
    .warnings {
      margin: 0;
      padding-left: 1.25rem;
    }
    .ok {
      color: var(--rl-ok);
      font-weight: 600;
    }
  `,
})
export class PlaygroundDiagnostics {
  readonly response = input.required<PlaygroundSearchResponse>();
  protected readonly model = describeModel;
}
