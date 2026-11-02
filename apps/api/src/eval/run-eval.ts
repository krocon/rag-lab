import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig, type AppConfig } from '../config/env.js';
import { loadEnvFile } from '../config/load-env-file.js';
import { createDatabase, type DatabaseConnection } from '../db/client.js';
import { createPgProbe } from '../db/probe.js';
import { EMBEDDING_COLUMN_DIMENSIONS } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { createChatProvider } from '../modules/chat/create-chat-provider.js';
import { createEmbeddingProvider } from '../modules/embeddings/create-embedding-provider.js';
import type { EmbeddingProvider } from '../modules/embeddings/embedding-provider.js';
import type { IndexerLogger } from '../modules/ingestion/document-indexer.js';
import { createServices, type AppServices } from '../services.js';
import { DatasetError, loadDataset } from './dataset.js';
import { DEFAULT_KS, EvalError, runEvaluation } from './evaluate.js';
import { runInjectionCheck } from './injection-check.js';
import { createLexicalEmbeddingProvider } from './lexical-embedding-provider.js';
import { buildResultFile, formatReport, resultFileName, type RunConfiguration } from './report.js';

/**
 * `pnpm eval` – retrieval evaluation against the configured embedding model (docs/evaluation.md).
 *
 * Lives in apps/api/src/eval because it drives the real API services (createServices) with the
 * API's configuration, database and providers; a separate package would have to duplicate that
 * wiring. It is not reachable over HTTP.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DEFAULT_DATASET = join(REPO_ROOT, 'eval/datasets/raglab-docs');
const DEFAULT_OUT = join(REPO_ROOT, 'eval/results');

const HELP = `Usage: pnpm eval [options]

Indexes an evaluation dataset into a temporary collection (real upload, chunking and embedding),
runs every query through the retrieval service and reports Recall@K, Precision@K, Hit-Rate@K and
MRR for K = ${DEFAULT_KS.join(', ')}. Needs PostgreSQL (DATABASE_URL) and – unless --baseline – Ollama
with EMBEDDING_MODEL installed.

Options:
  --dataset <dir>   Dataset directory (default: eval/datasets/raglab-docs)
  --out <dir>       Directory for the JSON result (default: eval/results, git-ignored)
  --baseline        Use the deterministic lexical baseline (hashed bag of words) instead of the
                    configured embedding model – no Ollama needed, not a semantic model
  --injection       Instead of the retrieval evaluation: ask the chat model questions about the
                    prompt-injection fixture and report heuristic findings (needs CHAT_MODEL)
  --keep            Keep the temporary collection instead of deleting it
  -h, --help        Show this help`;

interface CliOptions {
  dataset: string;
  out: string;
  baseline: boolean;
  injection: boolean;
  keep: boolean;
}

/** Where the user ran `pnpm eval` (pnpm runs the script inside apps/api and sets INIT_CWD). */
function invocationDirectory(): string {
  return process.env['INIT_CWD'] ?? process.cwd();
}

export function parseCli(argv: string[]): CliOptions | 'help' {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== '--'),
    options: {
      dataset: { type: 'string' },
      out: { type: 'string' },
      baseline: { type: 'boolean', default: false },
      injection: { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help) {
    return 'help';
  }
  return {
    dataset: values.dataset ? resolve(invocationDirectory(), values.dataset) : DEFAULT_DATASET,
    out: values.out ? resolve(invocationDirectory(), values.out) : DEFAULT_OUT,
    baseline: values.baseline,
    injection: values.injection,
    keep: values.keep,
  };
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Indexer log lines without document content (ids and messages only). */
const cliLogger: IndexerLogger = {
  info: () => undefined,
  warn: (_object, message) => console.error(`[indexer] ${message}`),
  error: (object, message) => {
    const err = (object as { err?: { message?: string } }).err;
    console.error(`[indexer] ${message}${err?.message ? `: ${err.message}` : ''}`);
  },
};

async function assertProviderReady(
  kind: 'Embedding' | 'Chat',
  provider: {
    model: string;
    checkStatus(): Promise<{
      reachable: boolean;
      modelAvailable: boolean | null;
      error?: string;
      hint?: string;
    }>;
  },
  config: AppConfig,
): Promise<void> {
  const status = await provider.checkStatus();
  if (!status.reachable) {
    throw new EvalError(
      `Ollama is not reachable at ${config.ollama.baseUrl}${status.error ? ` (${status.error})` : ''}. ` +
        'Start Ollama, or use "pnpm eval --baseline" for the lexical baseline without a model.',
    );
  }
  if (status.modelAvailable === false) {
    throw new EvalError(
      `${kind} model "${provider.model}" is not installed in Ollama. ` +
        `${status.hint ?? `Install it with "ollama pull ${provider.model}".`} ` +
        'RAGLab never downloads models itself.',
    );
  }
}

async function assertDatabaseReady(
  connection: DatabaseConnection,
  dimensions: number,
): Promise<void> {
  const checks = await createPgProbe(connection.pool, { embeddingDimensions: dimensions }).check();
  if (checks.database.status !== 'up') {
    throw new EvalError(
      `PostgreSQL is not reachable via DATABASE_URL (${checks.database.error ?? 'unknown error'}). ` +
        'Start it with "pnpm db:up" and apply migrations with "pnpm db:migrate".',
    );
  }
  if (checks.pgvector.status !== 'up' || checks.schema.status !== 'up') {
    throw new EvalError(
      `The database schema is not ready: ${checks.pgvector.error ?? checks.schema.error ?? 'embedding column mismatch'}. ` +
        'Run "pnpm db:migrate" and check EMBEDDING_DIMENSIONS.',
    );
  }
}

async function main(argv: string[]): Promise<number> {
  const options = parseCli(argv);
  if (options === 'help') {
    console.log(HELP);
    return 0;
  }
  loadEnvFile();
  const config = loadConfig();
  const dataset = options.injection ? undefined : await loadDataset(options.dataset);

  const embeddingProvider: EmbeddingProvider = options.baseline
    ? createLexicalEmbeddingProvider(EMBEDDING_COLUMN_DIMENSIONS)
    : createEmbeddingProvider(config);
  if (!options.baseline) {
    await assertProviderReady('Embedding', embeddingProvider, config);
  }
  const chatProvider = createChatProvider(config);
  if (options.injection) {
    await assertProviderReady('Chat', chatProvider, config);
  }

  const connection = createDatabase(config.database.url, 4);
  const abort = new AbortController();
  const onSignal = () => {
    console.error('\nAborting – cleaning up the temporary collection …');
    abort.abort(new EvalError('Aborted by the user.'));
  };
  process.once('SIGINT', onSignal);
  let services: AppServices | undefined;
  try {
    await assertDatabaseReady(connection, embeddingProvider.dimensions);
    services = createServices(connection.db, config, cliLogger, {
      embeddingProvider,
      chatProvider,
      collectionEmbedding: {
        provider: embeddingProvider.id,
        model: embeddingProvider.model,
        dimensions: embeddingProvider.dimensions,
      },
    });
    const createdAt = new Date();
    const stamp = createdAt.toISOString().replace(/[:.]/g, '-');
    await mkdir(options.out, { recursive: true });

    if (options.injection) {
      const answers = await runInjectionCheck({
        services,
        collectionName: `eval-injection-${stamp}`,
        keep: options.keep,
        signal: abort.signal,
      });
      for (const answer of answers) {
        console.log(
          `\nQ: ${answer.question}\nStatus: ${answer.status} · sources: ${answer.sources}`,
        );
        console.log(`A: ${answer.answer.trim() || '(empty)'}`);
        console.log(
          `Heuristics: ${answer.assessment.verdict}${answer.assessment.flags.length ? ` – ${answer.assessment.flags.join('; ')}` : ''}`,
        );
      }
      const file = join(options.out, resultFileName(createdAt, chatProvider.model, '-injection'));
      await writeFile(
        file,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            createdAt: createdAt.toISOString(),
            note: 'Sample of one model; heuristics detect obvious compliance only. Not a CI gate.',
            chat: { provider: chatProvider.id, model: chatProvider.model },
            embedding: { provider: embeddingProvider.id, model: embeddingProvider.model },
            gitCommit: git(['rev-parse', 'HEAD']),
            answers,
          },
          null,
          2,
        )}\n`,
      );
      console.log(`\nAnswers written to ${file}`);
      return 0;
    }

    if (!dataset) {
      throw new EvalError('No dataset loaded.');
    }
    const status = git(['status', '--porcelain']);
    const configuration: RunConfiguration = {
      embedding: {
        provider: embeddingProvider.id,
        model: embeddingProvider.model,
        dimensions: embeddingProvider.dimensions,
      },
      chunkSize: config.chunking.targetSize,
      chunkOverlap: config.chunking.overlap,
      topK: Math.max(...DEFAULT_KS),
      ks: [...DEFAULT_KS],
      gitCommit: git(['rev-parse', 'HEAD']),
      gitDirty: status === null ? null : status.length > 0,
    };
    const run = await runEvaluation({
      services,
      dataset,
      collectionName: `eval-${dataset.name}-${stamp}`,
      keep: options.keep,
      signal: abort.signal,
      onProgress: (message) => console.error(message),
    });
    console.log(`\n${formatReport(run, dataset, configuration)}`);
    const file = join(options.out, resultFileName(createdAt, embeddingProvider.model));
    await writeFile(
      file,
      `${JSON.stringify(buildResultFile(run, dataset, configuration, createdAt), null, 2)}\n`,
    );
    console.log(`\nResult written to ${file}`);
    if (run.kept) {
      console.log(`Collection kept: ${run.collectionId}`);
    }
    return 0;
  } finally {
    process.removeListener('SIGINT', onSignal);
    await services?.ingestion.close();
    await connection.close();
  }
}

/** Known failures → one readable message, no stack trace (set RAGLAB_EVAL_DEBUG=1 for one). */
export function describeFailure(error: unknown): string {
  if (error instanceof EvalError || error instanceof ConfigError || error instanceof DatasetError) {
    return error.message;
  }
  if (error instanceof AppError) {
    return `${error.code}: ${error.message}`;
  }
  if (
    error instanceof Error &&
    (error as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
  ) {
    return `${error.message}\n\n${HELP}`;
  }
  return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}

const isEntryPoint =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isEntryPoint) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`pnpm eval failed: ${describeFailure(error)}`);
      if (process.env['RAGLAB_EVAL_DEBUG'] === '1' && error instanceof Error) {
        console.error(error.stack);
      }
      process.exitCode = 1;
    });
}
