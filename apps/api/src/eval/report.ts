import type { EvalDataset } from './dataset.js';
import type { EvaluationRun } from './evaluate.js';
import type { LevelMetrics } from './metrics.js';

/** Everything that makes two runs comparable (stored in every result file). */
export interface RunConfiguration {
  embedding: { provider: string; model: string; dimensions: number };
  chunkSize: number;
  chunkOverlap: number;
  /** Results requested per query (`max(ks)`). */
  topK: number;
  ks: number[];
  /** `git rev-parse HEAD`, `null` outside a Git checkout. */
  gitCommit: string | null;
  /** Uncommitted changes in the working tree when the run started. */
  gitDirty: boolean | null;
}

export interface EvalResultFile {
  schemaVersion: 1;
  createdAt: string;
  dataset: { name: string; sha256: string; documents: number; queries: number };
  configuration: RunConfiguration;
  indexing: EvaluationRun['indexing'];
  searchDurationMs: number;
  unresolvedAnchors: string[];
  summary: EvaluationRun['summary'];
  queries: EvaluationRun['queries'];
}

export function buildResultFile(
  run: EvaluationRun,
  dataset: EvalDataset,
  configuration: RunConfiguration,
  createdAt: Date,
): EvalResultFile {
  return {
    schemaVersion: 1,
    createdAt: createdAt.toISOString(),
    dataset: {
      name: dataset.name,
      sha256: dataset.sha256,
      documents: dataset.documents.length,
      queries: dataset.queries.length,
    },
    configuration,
    indexing: run.indexing,
    searchDurationMs: run.searchDurationMs,
    unresolvedAnchors: run.unresolvedAnchors,
    summary: run.summary,
    queries: run.queries,
  };
}

/** `2026-11-02T12-30-05Z-nomic-embed-text.json` – sortable, safe on every file system. */
export function resultFileName(createdAt: Date, model: string, suffix = ''): string {
  const timestamp = createdAt
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');
  const safeModel = model.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'model';
  return `${timestamp}-${safeModel}${suffix}.json`;
}

const formatValue = (value: number | null | undefined) =>
  value === null || value === undefined ? 'n/a' : value.toFixed(3);

function levelRows(level: string, metrics: LevelMetrics, ks: readonly number[]): string[][] {
  return ks.map((k) => {
    const atK = metrics.atK[String(k)];
    return [
      level,
      String(k),
      formatValue(atK?.recall),
      formatValue(atK?.precision),
      formatValue(atK?.hitRate),
    ];
  });
}

function table(rows: readonly string[][]): string {
  const widths =
    rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

/** Human-readable summary for the terminal (deterministic for a given run and configuration). */
export function formatReport(
  run: EvaluationRun,
  dataset: EvalDataset,
  configuration: RunConfiguration,
): string {
  const { embedding } = configuration;
  const header = [
    `RAGLab retrieval evaluation – dataset "${dataset.name}" (${dataset.documents.length} documents, ` +
      `${dataset.queries.length} queries, ${run.indexing.chunks} chunks)`,
    `Embedding: ${embedding.provider} / ${embedding.model} (${embedding.dimensions} dimensions) · ` +
      `CHUNK_SIZE ${configuration.chunkSize} · CHUNK_OVERLAP ${configuration.chunkOverlap} · topK ${configuration.topK}`,
    '',
  ];
  const rows = [
    ['Level', 'K', 'Recall', 'Precision', 'Hit rate'],
    ...levelRows('document', run.summary.document, run.ks),
    ...levelRows('section', run.summary.section, run.ks),
  ];
  const lines = [
    ...header,
    table(rows),
    '',
    `MRR@${run.topK}: document ${formatValue(run.summary.document.mrr)} · section ${formatValue(run.summary.section.mrr)}`,
  ];

  const missK = run.ks.includes(5) ? 5 : run.topK;
  const missed = run.queries
    .filter((query) => query.document.atK[String(missK)]?.hitRate === 0)
    .map((query) => query.id);
  lines.push(
    missed.length > 0
      ? `Queries without a relevant document in the top ${missK}: ${missed.join(', ')}`
      : `Every query has a relevant document in the top ${missK}.`,
  );
  if (run.unresolvedAnchors.length > 0) {
    lines.push(
      `Anchors no chunk matches (cannot be found at section level): ${run.unresolvedAnchors.join(', ')}`,
    );
  }
  return lines.join('\n');
}
