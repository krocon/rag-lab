import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { loadDataset, type EvalDataset } from '../../src/eval/dataset.js';
import { runEvaluation, type EvaluationRun } from '../../src/eval/evaluate.js';
import { createLexicalEmbeddingProvider } from '../../src/eval/lexical-embedding-provider.js';
import type { EmbeddingProvider } from '../../src/modules/embeddings/embedding-provider.js';
import { createServices } from '../../src/services.js';
import { createFakeChatProvider } from '../fakes/fake-chat-provider.js';
import { createFakeEmbeddingProvider } from '../fakes/fake-embedding-provider.js';
import { silentLogger, testConfig } from '../helpers.js';
import { count, integrationDatabaseUrl, resetDatabase } from './setup.js';

/**
 * Evaluation smoke test (CI, no Ollama): the bundled dataset runs through the real upload,
 * chunking, embedding step, pgvector retrieval and metrics – with the deterministic lexical
 * baseline instead of a model. It checks the WIRING of the evaluation, not the quality of a real
 * embedding model (docs/evaluation.md §6).
 *
 * The full dataset is used (not a subset): it has ~64 chunks and indexes in well under a second.
 *
 * Thresholds: the baseline measures document Hit-Rate@5 = 1.0, Recall@10 = 1.0, MRR ≈ 0.95,
 * section Recall@5 ≈ 0.98, MRR ≈ 0.90 (CHUNK_SIZE 1200, overlap 200). The thresholds sit
 * 0.1–0.2 below that, so harmless dataset or chunking edits do not break CI, while broken wiring
 * (wrong collection, lost ranking, mismatched anchors) drops far below them – see the control run
 * with pseudo-random vectors, which lands near chance level.
 */
const databaseUrl = integrationDatabaseUrl();
const connection = createDatabase(databaseUrl, 4);
const { pool } = connection;
const config = testConfig({ DATABASE_URL: databaseUrl, CHUNK_SIZE: '1200', CHUNK_OVERLAP: '200' });
const datasetDirectory = fileURLToPath(
  new URL('../../../../eval/datasets/raglab-docs', import.meta.url),
);
let dataset: EvalDataset;

function evaluate(
  provider: EmbeddingProvider,
  name: string,
  data: EvalDataset = dataset,
): Promise<EvaluationRun> {
  const services = createServices(connection.db, config, silentLogger, {
    embeddingProvider: provider,
    chatProvider: createFakeChatProvider({ forbidCalls: true }),
    collectionEmbedding: {
      provider: provider.id,
      model: provider.model,
      dimensions: provider.dimensions,
    },
  });
  return runEvaluation({ services, dataset: data, collectionName: name }).finally(() =>
    services.ingestion.close(),
  );
}

beforeAll(async () => {
  await runMigrations(databaseUrl);
  dataset = await loadDataset(datasetDirectory);
});

beforeEach(async () => {
  await resetDatabase(pool);
});

afterAll(async () => {
  await resetDatabase(pool);
  await connection.close();
});

describe('retrieval evaluation smoke test (lexical baseline, PostgreSQL)', () => {
  it('indexes the dataset, reaches the minimum metrics and removes the collection', async () => {
    const run = await evaluate(createLexicalEmbeddingProvider(768), 'eval-smoke');

    expect(run.indexing.documents).toBe(dataset.documents.length);
    expect(run.indexing.chunks).toBeGreaterThan(dataset.documents.length);
    expect(run.unresolvedAnchors).toEqual([]);
    expect(run.queries).toHaveLength(dataset.queries.length);
    for (const query of run.queries) {
      expect(query.results).toHaveLength(10);
    }

    const { document, section } = run.summary;
    expect(document.atK['5']?.hitRate).toBeGreaterThanOrEqual(0.9);
    expect(document.atK['10']?.recall).toBeGreaterThanOrEqual(0.9);
    expect(document.mrr).toBeGreaterThanOrEqual(0.75);
    expect(section.atK['5']?.recall).toBeGreaterThanOrEqual(0.8);
    expect(section.mrr).toBeGreaterThanOrEqual(0.7);

    // Temporary collection, documents and chunks are gone.
    expect(await count(pool, 'collections')).toBe(0);
    expect(await count(pool, 'chunks')).toBe(0);
  });

  it('is reproducible: two runs give identical metrics and rankings', async () => {
    const first = await evaluate(createLexicalEmbeddingProvider(768), 'eval-repro-1');
    const second = await evaluate(createLexicalEmbeddingProvider(768), 'eval-repro-2');
    expect(second.summary).toEqual(first.summary);
    const rankings = (run: EvaluationRun) =>
      run.queries.map((query) => query.results.map((hit) => `${hit.filename}:${hit.chunkIndex}`));
    expect(rankings(second)).toEqual(rankings(first));
  });

  it('control: pseudo-random vectors stay far below the thresholds', async () => {
    const run = await evaluate(createFakeEmbeddingProvider({ dimensions: 768 }), 'eval-control');
    expect(run.summary.document.mrr).toBeLessThan(0.5);
    expect(run.summary.section.atK['5']?.recall).toBeLessThan(0.5);
  });
});

describe('code dataset (017): source tree with paths, lexical baseline, PostgreSQL', () => {
  it('indexes code and Markdown with paths and finds the relevant files', async () => {
    const code = await loadDataset(
      fileURLToPath(new URL('../../../../eval/datasets/code-gridkit', import.meta.url)),
    );
    expect(code.documents.map((document) => document.filename)).toContain(
      'src/tree/tree-model.ts',
    );
    const run = await evaluate(createLexicalEmbeddingProvider(768), 'eval-code', code);
    expect(run.unresolvedAnchors).toEqual([]);
    expect(run.indexing.documents).toBe(code.documents.length);
    // Baseline measures document Hit-Rate@5 = 1.0, Recall@10 = 1.0, MRR ≈ 0.94, section
    // Recall@5 ≈ 0.81, MRR ≈ 0.90; thresholds sit 0.15 below (see the smoke test above).
    const { document, section } = run.summary;
    expect(document.atK['5']?.hitRate).toBeGreaterThanOrEqual(0.85);
    expect(document.atK['10']?.recall).toBeGreaterThanOrEqual(0.85);
    expect(document.mrr).toBeGreaterThanOrEqual(0.75);
    expect(section.atK['5']?.recall).toBeGreaterThanOrEqual(0.65);
    expect(section.mrr).toBeGreaterThanOrEqual(0.7);
  });
});
