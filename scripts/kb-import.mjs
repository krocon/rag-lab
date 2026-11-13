#!/usr/bin/env node
// @ts-check
/**
 * Imports a local directory or a Git repository (source code, Markdown, text) into a RAGLab
 * collection through the public REST API (ADR 0004).
 *
 *   pnpm kb:import --source <dir | git-url> --name <collection>
 *                  [--ref <branch|tag|sha>] [--include <glob>]... [--exclude <glob>]...
 *                  [--max-bytes <n>] [--api-url <url>] [--sync] [--dry-run] [--timeout <s>]
 *
 * Exits 1 on errors (API or Ollama not reachable, git failed, upload rejected) and when a document
 * failed to index or was rejected by the API.
 */
import { parseArgs } from 'node:util';
import { GitSourceError } from './kb/git-source.mjs';
import { ImportError, runImport } from './kb/import-lib.mjs';
import { SKIP_REASON_TEXT } from './kb/select-lib.mjs';

const HELP = `Usage: pnpm kb:import --source <dir | git-url> --name <collection> [options]

Imports source code, Markdown and text files of a local directory or a Git repository into a
RAGLab collection (via the REST API) and waits until they are indexed.

Options:
  --source <dir|url>  Local directory or Git URL (https://…, ssh://…, git@host:owner/repo.git)
  --name <name>       Collection name; an existing collection with this name is updated
  --ref <ref>         Branch, tag or commit SHA to clone (Git URLs only; default branch otherwise)
  --include <glob>    Only import matching files (gitignore syntax, repeatable)
  --exclude <glob>    Additionally exclude matching files (gitignore syntax, repeatable);
                      a .raglabignore file in the source directory works the same way
  --max-bytes <n>     Skip files larger than n bytes (default 1048576, at most MAX_UPLOAD_BYTES)
  --api-url <url>     RAGLab API base URL (default: $RAGLAB_API_URL or http://127.0.0.1:3000)
  --sync              Replace changed files and delete documents whose file no longer exists
                      (without it, nothing is deleted)
  --dry-run           List what would be imported and why files are skipped – no API access
  --verbose           With --dry-run: list every selected and skipped file
  --timeout <s>       Maximum seconds to wait for indexing (default: 3600)
  -h, --help          Show this help

Never imported: node_modules, dist, build and other build/cache directories, lockfiles, binary and
media files, minified files, source maps, files with very long lines, and anything listed in
.gitignore. Files that may contain secrets (.env*, *.pem, *.key, id_rsa*, .npmrc, …) are never
uploaded, not even with --include.`;

/** @param {number} bytes */
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

/**
 * @param {import('./kb/import-lib.mjs').ImportResult} result
 * @param {boolean} verbose
 */
function printSelection(result, verbose) {
  const total = result.selected.reduce((sum, file) => sum + file.bytes, 0);
  console.log('');
  console.log(`Selected ${result.selected.length} files (${formatBytes(total)}):`);
  for (const entry of result.summary) {
    console.log(
      `  ${entry.extension.padEnd(10)} ${String(entry.files).padStart(6)} files ${formatBytes(entry.bytes).padStart(10)}`,
    );
  }
  console.log(`  ≈ ${result.estimatedChunks} chunks (rough estimate)`);

  /** @type {Map<string, import('./kb/select-lib.mjs').SkippedFile[]>} */
  const byReason = new Map();
  for (const file of result.skipped) {
    byReason.set(file.reason, [...(byReason.get(file.reason) ?? []), file]);
  }
  console.log('');
  console.log(`Skipped ${result.skipped.length} files:`);
  for (const [reason, files] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(files.length).padStart(6)}  ${reason} – ${SKIP_REASON_TEXT[reason]}`);
    const shown = verbose || reason === 'secret' ? files : files.slice(0, 3);
    for (const file of shown) {
      console.log(`            ${file.path}${file.duplicateOf ? ` (= ${file.duplicateOf})` : ''}`);
    }
    if (shown.length < files.length) {
      console.log(`            … ${files.length - shown.length} more (--verbose lists all)`);
    }
  }
  if (verbose) {
    console.log('');
    console.log('Selected files:');
    for (const file of result.selected) console.log(`  ${file.path}`);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' },
      name: { type: 'string' },
      ref: { type: 'string' },
      include: { type: 'string', multiple: true, default: [] },
      exclude: { type: 'string', multiple: true, default: [] },
      'max-bytes': { type: 'string' },
      'api-url': { type: 'string' },
      sync: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      timeout: { type: 'string', default: '3600' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (!values.source) throw new ImportError('--source is required (a directory or a Git URL). See --help.');
  if (!values.name && !values['dry-run']) throw new ImportError('--name is required. See --help.');
  const timeoutSeconds = Number(values.timeout);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new ImportError(`--timeout must be a positive number of seconds, got "${values.timeout}"`);
  }
  const maxBytes = values['max-bytes'] === undefined ? undefined : Number(values['max-bytes']);
  if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes <= 0)) {
    throw new ImportError(`--max-bytes must be a positive integer, got "${values['max-bytes']}"`);
  }
  const apiUrl = values['api-url'] ?? process.env.RAGLAB_API_URL ?? 'http://127.0.0.1:3000';

  const result = await runImport({
    source: values.source,
    name: values.name ?? '',
    ...(values.ref === undefined ? {} : { ref: values.ref }),
    include: values.include,
    exclude: values.exclude,
    ...(maxBytes === undefined ? {} : { maxBytes }),
    apiUrl,
    sync: values.sync,
    dryRun: values['dry-run'],
    timeoutMs: timeoutSeconds * 1000,
    log: (line) => console.log(line),
  });

  const { source } = result;
  console.log(
    `Source: ${source.kind === 'git' ? 'Git repository' : 'directory'} ${source.url ?? source.label}` +
      `${source.ref ? ` @ ${source.ref}` : ''}${source.commit ? ` (${source.commit.slice(0, 12)})` : ''}` +
      `${source.clean === false ? ' – uncommitted changes: links may not match the files' : ''}`,
  );
  printSelection(result, values.verbose);
  if (result.dryRun) {
    console.log('');
    console.log('Dry run – nothing was sent to the API. Run without --dry-run to import.');
    return 0;
  }

  const documents = result.documents ?? [];
  const failed = documents.filter((document) => document.status === 'failed');
  const rejected = result.rejected ?? [];
  console.log('');
  for (const document of failed) {
    console.log(`  failed  ${document.path}: ${document.errorMessage ?? 'unknown error'}`);
  }
  for (const entry of rejected) {
    console.log(`  rejected ${entry.path}: ${entry.message}`);
  }
  const plan = result.plan;
  console.log(
    `Collection "${result.collection?.name}" (${result.collection?.id}): ` +
      `${documents.length - failed.length} ready, ${failed.length} failed; uploaded ${result.uploaded?.length ?? 0}, ` +
      `unchanged ${plan?.unchanged.length ?? 0}, replaced ${result.replaced?.length ?? 0}, ` +
      `deleted ${result.deleted?.length ?? 0}, rejected ${rejected.length}` +
      `${plan && !values.sync && plan.changed.length + plan.removed.length > 0 ? ` (${plan.changed.length} changed and ${plan.removed.length} removed files not synced – use --sync)` : ''}.`,
  );
  if (failed.length > 0 || rejected.length > 0) {
    console.error('Some files were not indexed – see above. Fix the cause and run the command again.');
    return 1;
  }
  console.log(`Open the web app → Chat or Retrieval Playground and pick "${result.collection?.name}".`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    const known = error instanceof ImportError || error instanceof GitSourceError;
    console.error(`kb:import: ${known ? error.message : error}`);
    process.exit(1);
  },
);
