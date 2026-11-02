import { describe, expect, it } from 'vitest';
import { parseDataset } from '../../src/eval/dataset.js';
import type { EvaluationRun } from '../../src/eval/evaluate.js';
import { computeLevelMetrics } from '../../src/eval/metrics.js';
import {
  buildResultFile,
  formatReport,
  resultFileName,
  type RunConfiguration,
} from '../../src/eval/report.js';

const dataset = parseDataset(
  'mini',
  [
    { filename: 'a.md', raw: '# A\n\ntext' },
    { filename: 'b.txt', raw: 'other' },
  ],
  [
    JSON.stringify({ id: 'q1', query: 'a', relevant: [{ document: 'a.md' }] }),
    JSON.stringify({ id: 'q2', query: 'b', relevant: [{ document: 'b.txt' }] }),
  ].join('\n'),
);

const ks = [1, 5];
const hitQuery = computeLevelMetrics([['a.md'], ['b.txt']], new Set(['a.md']), ks);
const missQuery = computeLevelMetrics([['a.md']], new Set(['b.txt']), ks);
const run: EvaluationRun = {
  collectionId: 'c1',
  kept: false,
  ks,
  topK: 5,
  indexing: { documents: 2, chunks: 2, durationMs: 12 },
  unresolvedAnchors: ['b.txt~"gone"'],
  queries: [
    {
      id: 'q1',
      query: 'a',
      relevantDocuments: ['a.md'],
      relevantAnchors: ['a.md'],
      results: [],
      document: hitQuery,
      section: hitQuery,
    },
    {
      id: 'q2',
      query: 'b',
      relevantDocuments: ['b.txt'],
      relevantAnchors: ['b.txt'],
      results: [],
      document: missQuery,
      section: missQuery,
    },
  ],
  summary: {
    document: {
      atK: {
        '1': { recall: 0.5, precision: 0.5, hitRate: 0.5 },
        '5': { recall: 0.5, precision: 0.1, hitRate: 0.5 },
      },
      mrr: 0.5,
    },
    section: {
      atK: {
        '1': { recall: 0.5, precision: 0.5, hitRate: 0.5 },
        '5': { recall: null, precision: null, hitRate: null },
      },
      mrr: null,
    },
  },
  searchDurationMs: 3,
};
const configuration: RunConfiguration = {
  embedding: { provider: 'ollama', model: 'nomic-embed-text', dimensions: 768 },
  chunkSize: 1200,
  chunkOverlap: 200,
  topK: 5,
  ks,
  gitCommit: 'abc123',
  gitDirty: false,
};

describe('formatReport', () => {
  it('prints configuration, a metrics table, MRR, misses and unresolved anchors', () => {
    expect(formatReport(run, dataset, configuration)).toBe(
      [
        'RAGLab retrieval evaluation – dataset "mini" (2 documents, 2 queries, 2 chunks)',
        'Embedding: ollama / nomic-embed-text (768 dimensions) · CHUNK_SIZE 1200 · CHUNK_OVERLAP 200 · topK 5',
        '',
        'Level     K  Recall  Precision  Hit rate',
        'document  1  0.500   0.500      0.500',
        'document  5  0.500   0.100      0.500',
        'section   1  0.500   0.500      0.500',
        'section   5  n/a     n/a        n/a',
        '',
        'MRR@5: document 0.500 · section n/a',
        'Queries without a relevant document in the top 5: q2',
        'Anchors no chunk matches (cannot be found at section level): b.txt~"gone"',
      ].join('\n'),
    );
  });

  it('says so when every query has a hit', () => {
    const allHit = { ...run, unresolvedAnchors: [], queries: run.queries.slice(0, 1) };
    expect(formatReport(allHit, dataset, configuration)).toMatch(
      /Every query has a relevant document in the top 5\.$/,
    );
  });
});

describe('result file', () => {
  it('names files by UTC timestamp and a file-system-safe model name', () => {
    const date = new Date('2026-11-02T12:30:05.123Z');
    expect(resultFileName(date, 'nomic-embed-text')).toBe(
      '2026-11-02T12-30-05Z-nomic-embed-text.json',
    );
    expect(resultFileName(date, 'library/llama3.2:latest', '-injection')).toBe(
      '2026-11-02T12-30-05Z-library_llama3.2_latest-injection.json',
    );
    expect(resultFileName(date, '::')).toBe('2026-11-02T12-30-05Z-model.json');
  });

  it('stores dataset identity, configuration and all per-query details', () => {
    const file = buildResultFile(run, dataset, configuration, new Date('2026-11-02T12:00:00Z'));
    expect(file).toMatchObject({
      schemaVersion: 1,
      createdAt: '2026-11-02T12:00:00.000Z',
      dataset: { name: 'mini', sha256: dataset.sha256, documents: 2, queries: 2 },
      configuration,
      indexing: run.indexing,
      unresolvedAnchors: run.unresolvedAnchors,
      summary: run.summary,
    });
    expect(file.queries).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(file))).toEqual(file);
  });
});
