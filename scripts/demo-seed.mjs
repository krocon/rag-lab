#!/usr/bin/env node
// @ts-check
/**
 * Loads the demo knowledge base (examples/demo-knowledge-base) into a running RAGLab through the
 * public REST API.
 *
 *   pnpm demo:seed [--reset] [--api-url <url>] [--name <collection>] [--description <text>]
 *                  [--dir <path>] [--timeout <s>]
 *
 * Idempotent: an existing collection with the same name is reused and only missing files are
 * uploaded; --reset deletes the collection first. Exits 1 on errors (API or Ollama not reachable,
 * embedding model missing, upload rejected) and when a document failed to index.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SeedError, seedDemo } from './demo/seed-lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

const DEFAULT_DESCRIPTION =
  'Demo: documentation of Kettlebird, a fictional job scheduler (examples/demo-knowledge-base).';

const HELP = `Usage: pnpm demo:seed [options]

Loads examples/demo-knowledge-base into RAGLab via the REST API and waits for indexing.

Options:
  --api-url <url>   RAGLab API base URL (default: $RAGLAB_API_URL or http://127.0.0.1:3000;
                    the Docker stack: http://127.0.0.1:8080)
  --name <name>     Collection name (default: "RAGLab Demo")
  --description <t> Description of a newly created collection
  --dir <path>      Directory with the files to upload (default: examples/demo-knowledge-base)
  --reset           Delete the collection first and upload everything again
  --timeout <s>     Maximum seconds to wait for indexing (default: 300)
  -h, --help        Show this help

The embedding model configured in the API (EMBEDDING_MODEL) must be installed in Ollama –
RAGLab never downloads models.`;

/** Markdown and text files of the dataset, except its README. */
function readDemoFiles(dir) {
  return readdirSync(dir)
    .filter((name) => /\.(md|markdown|txt)$/i.test(name) && name.toLowerCase() !== 'readme.md')
    .sort()
    .map((name) => ({ name, content: readFileSync(join(dir, name), 'utf8') }));
}

async function main() {
  const { values } = parseArgs({
    options: {
      'api-url': { type: 'string' },
      name: { type: 'string', default: 'RAGLab Demo' },
      description: { type: 'string', default: DEFAULT_DESCRIPTION },
      dir: { type: 'string', default: join(root, 'examples', 'demo-knowledge-base') },
      reset: { type: 'boolean', default: false },
      timeout: { type: 'string', default: '300' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const timeoutSeconds = Number(values.timeout);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new SeedError(`--timeout must be a positive number of seconds, got "${values.timeout}"`);
  }
  const apiUrl = values['api-url'] ?? process.env.RAGLAB_API_URL ?? 'http://127.0.0.1:3000';
  const dir = resolve(values.dir);
  let files;
  try {
    files = readDemoFiles(dir);
  } catch {
    throw new SeedError(`Cannot read the demo directory ${dir}`);
  }

  console.log(`Seeding ${files.length} files from ${dir} into "${values.name}" at ${apiUrl}`);
  const result = await seedDemo({
    apiUrl,
    name: values.name,
    description: values.description,
    files,
    reset: values.reset,
    timeoutMs: timeoutSeconds * 1000,
    log: (line) => console.log(line),
  });

  console.log('');
  for (const document of result.documents) {
    const detail =
      document.status === 'failed'
        ? `  ${document.errorMessage ?? ''}`
        : `  ${document.chunkCount} chunks`;
    console.log(`  ${document.status.padEnd(7)} ${document.filename}${detail}`);
  }
  const failed = result.documents.filter((document) => document.status === 'failed');
  const ready = result.documents.length - failed.length;
  console.log('');
  console.log(
    `Collection "${result.collection.name}" (${result.collection.id}): ${ready} ready, ` +
      `${failed.length} failed; uploaded ${result.uploaded.length}, already present ` +
      `${result.skipped.length}, reindexed ${result.reindexed.length}.`,
  );
  if (failed.length > 0) {
    console.error('Some documents failed – fix the cause above and run the command again.');
    return 1;
  }
  console.log(
    `Open the web app → Chat or Retrieval Playground and pick "${result.collection.name}".`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`demo:seed: ${error instanceof SeedError ? error.message : error}`);
    process.exit(1);
  },
);
