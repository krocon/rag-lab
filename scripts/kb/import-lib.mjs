// @ts-check
/**
 * Logic of `pnpm kb:import` (scripts/kb-import.mjs): imports a local directory or a Git repository
 * into a RAGLab collection through the public REST API only (ADR 0004).
 *
 *   1. resolve the source: a local directory (inside a Git work tree: `git ls-files`, commit,
 *      branch and remote) or a Git URL (shallow clone into a temporary directory),
 *   2. select the files (select-lib.mjs) – `--dry-run` stops here and never contacts the API,
 *   3. reuse or create the collection, compare with its documents by path and content hash:
 *      new files are uploaded, unchanged ones skipped; with `sync`, changed files are replaced
 *      and files that no longer exist are deleted (summary first) – without it nothing is deleted,
 *   4. upload in batches within the server limits (MAX_UPLOAD_FILES, MAX_UPLOAD_REQUEST_BYTES),
 *      retrying after `429` (Retry-After), and record the import source,
 *   5. wait until every imported document is `ready` or `failed`.
 *
 * `fetch`, `sleep`, `log`, `git` and `now` are parameters so the tests can replace them.
 */
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cloneShallow, isGitUrl, readWorkTree, runGit, sourceUrlForStorage } from './git-source.mjs';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINE_LENGTH,
  DEFAULT_SUPPORTED_EXTENSIONS,
  comparePaths,
  estimateChunks,
  selectFiles,
  summarizeByExtension,
} from './select-lib.mjs';

/** An error with a message meant for the user of the command. */
export class ImportError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, details?: any, retryAfterSeconds?: number }} [extra]
   */
  constructor(message, extra = {}) {
    super(message);
    this.name = 'ImportError';
    this.status = extra.status;
    this.code = extra.code;
    this.details = extra.details;
    this.retryAfterSeconds = extra.retryAfterSeconds;
  }
}

/**
 * @typedef {import('./select-lib.mjs').SelectedFile} SelectedFile
 * @typedef {import('./select-lib.mjs').SkippedFile} SkippedFile
 * @typedef {{ id: string, path: string | null, filename: string, contentSha256: string,
 *   status: string, errorMessage: string | null, chunkCount: number }} RemoteDocument
 * @typedef {{ kind: 'directory' | 'git', url: string | null, ref: string | null,
 *   commit: string | null, label: string, clean?: boolean }} SourceInfo
 * @typedef {{
 *   upload: SelectedFile[],
 *   unchanged: SelectedFile[],
 *   changed: { file: SelectedFile, document: RemoteDocument }[],
 *   removed: RemoteDocument[],
 *   duplicateInCollection: { file: SelectedFile, document: RemoteDocument }[],
 *   reindex: RemoteDocument[],
 * }} ImportPlan
 */

/**
 * Compares the selected files with the collection's documents (by path, then content hash).
 * Documents without a path (uploaded in the web app) are never touched.
 *
 * - new path → `upload` (unless the same content exists under another path that stays: then
 *   `duplicateInCollection`, because the API stores every content only once per collection),
 * - same path, same hash → `unchanged` (`reindex` if that document had failed),
 * - same path, other hash → `changed` (replaced only with `sync`),
 * - path no longer in the source → `removed` (deleted only with `sync`).
 *
 * @param {SelectedFile[]} files
 * @param {RemoteDocument[]} documents
 * @param {{ sync?: boolean }} [options]
 * @returns {ImportPlan}
 */
export function planImport(files, documents, options = {}) {
  const { sync = false } = options;
  const byPath = new Map(
    documents.flatMap((document) => (document.path === null ? [] : [[document.path, document]])),
  );
  const localPaths = new Set(files.map((file) => file.path));
  const removed = documents
    .filter((document) => document.path !== null && !localPaths.has(document.path))
    .sort((a, b) => comparePaths(a.path ?? '', b.path ?? ''));

  /** @type {ImportPlan['changed']} */
  const changed = [];
  /** @type {SelectedFile[]} */
  const candidates = [];
  /** @type {SelectedFile[]} */
  const unchanged = [];
  /** @type {RemoteDocument[]} */
  const reindex = [];
  for (const file of files) {
    const document = byPath.get(file.path);
    if (document === undefined) {
      candidates.push(file);
    } else if (document.contentSha256 === file.hash) {
      unchanged.push(file);
      if (document.status === 'failed') reindex.push(document);
    } else {
      changed.push({ file, document });
    }
  }

  // Content that stays in the collection after this run (deleted/replaced documents are gone).
  const leaving = new Set(
    sync ? [...removed, ...changed.map((entry) => entry.document)].map((d) => d.id) : [],
  );
  /** @type {Map<string, RemoteDocument>} */
  const remainingByHash = new Map();
  for (const document of documents) {
    if (!leaving.has(document.id)) remainingByHash.set(document.contentSha256, document);
  }
  /** @type {ImportPlan['duplicateInCollection']} */
  const duplicateInCollection = [];
  /** @type {SelectedFile[]} */
  const upload = [];
  for (const file of [...candidates, ...(sync ? changed.map((entry) => entry.file) : [])]) {
    const existing = remainingByHash.get(file.hash);
    if (existing !== undefined) {
      duplicateInCollection.push({ file, document: existing });
    } else {
      upload.push(file);
    }
  }
  upload.sort((a, b) => comparePaths(a.path, b.path));
  return { upload, unchanged, changed, removed, duplicateInCollection, reindex };
}

/**
 * Splits files into upload requests: at most `maxFiles` files and `maxRequestBytes` bytes each.
 * @template {{ bytes: number }} T
 * @param {T[]} files
 * @param {{ maxFiles: number, maxRequestBytes: number }} limits
 * @returns {T[][]}
 */
export function batchFiles(files, { maxFiles, maxRequestBytes }) {
  /** @type {T[][]} */
  const batches = [];
  /** @type {T[]} */
  let current = [];
  let bytes = 0;
  for (const file of files) {
    if (current.length > 0 && (current.length >= maxFiles || bytes + file.bytes > maxRequestBytes)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += file.bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Removes a trailing slash; only http(s). @param {string} apiUrl */
export function normaliseApiUrl(apiUrl) {
  let url;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new ImportError(`Invalid API URL "${apiUrl}" – expected e.g. http://127.0.0.1:3000`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ImportError(`Invalid API URL "${apiUrl}" – only http and https are supported`);
  }
  return url.href.replace(/\/+$/, '');
}

/**
 * A small client for the RAGLab API: JSON in and out, the API's error format as ImportError,
 * waiting and retrying after `429` as long as `Retry-After` says.
 * @param {{ apiUrl: string, fetch?: typeof fetch, sleep?: (ms: number) => Promise<void>,
 *   log?: (line: string) => void, requestTimeoutMs?: number, maxRateLimitRetries?: number }} options
 */
export function createApiClient(options) {
  const {
    fetch: fetchImpl = fetch,
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
    log = () => {},
    requestTimeoutMs = 120_000,
    maxRateLimitRetries = 20,
  } = options;
  const apiUrl = normaliseApiUrl(options.apiUrl);

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ json?: unknown, form?: () => FormData }} [body] form is a factory: a retry needs a fresh body
   */
  async function request(method, path, body = {}) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await requestOnce(method, path, body);
      } catch (error) {
        if (!(error instanceof ImportError) || error.status !== 429 || attempt > maxRateLimitRetries) {
          throw error;
        }
        const waitSeconds = error.retryAfterSeconds ?? 10;
        log(`Rate limited by the API – waiting ${waitSeconds} s …`);
        await sleep(waitSeconds * 1000);
      }
    }
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ json?: unknown, form?: () => FormData }} body
   */
  async function requestOnce(method, path, body) {
    /** @type {RequestInit} */
    const init = { method, signal: AbortSignal.timeout(requestTimeoutMs) };
    if (body.json !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body.json);
    } else if (body.form) {
      init.body = body.form();
    }
    let response;
    try {
      response = await fetchImpl(`${apiUrl}${path}`, init);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ImportError(
        `The RAGLab API is not reachable at ${apiUrl} (${reason}). Start it with "pnpm dev" or ` +
          '"docker compose --profile app up -d", or pass --api-url.',
      );
    }
    const text = await response.text();
    /** @type {any} */
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!response.ok) {
      const code = data?.error?.code ?? 'HTTP_ERROR';
      const message = data?.error?.message ?? (text.slice(0, 200) || response.statusText);
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new ImportError(`${method} ${path} failed with ${response.status} ${code}: ${message}`, {
        status: response.status,
        code,
        details: data?.error?.details,
        retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      });
    }
    return data;
  }

  return { apiUrl, request };
}

/**
 * @typedef {{
 *   source: string,
 *   name: string,
 *   ref?: string,
 *   include?: string[],
 *   exclude?: string[],
 *   maxBytes?: number,
 *   maxLineLength?: number,
 *   apiUrl?: string,
 *   sync?: boolean,
 *   dryRun?: boolean,
 *   timeoutMs?: number,
 *   pollIntervalMs?: number,
 *   allowFileUrls?: boolean,
 *   fetch?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: (line: string) => void,
 *   git?: import('./git-source.mjs').GitRunner,
 * }} ImportOptions
 *
 * @typedef {{
 *   source: SourceInfo,
 *   selected: SelectedFile[],
 *   skipped: SkippedFile[],
 *   summary: { extension: string, files: number, bytes: number }[],
 *   estimatedChunks: number,
 *   dryRun: boolean,
 *   collection?: { id: string, name: string },
 *   created?: boolean,
 *   plan?: ImportPlan,
 *   uploaded?: string[],
 *   replaced?: string[],
 *   deleted?: string[],
 *   reindexed?: string[],
 *   rejected?: { path: string, code: string, message: string }[],
 *   documents?: RemoteDocument[],
 * }} ImportResult
 */

/**
 * Runs an import (or a dry run). See the module comment for the steps.
 * @param {ImportOptions} options
 * @returns {Promise<ImportResult>}
 */
export async function runImport(options) {
  const { git = runGit, log = () => {} } = options;
  if (isGitUrl(options.source)) {
    const clone = await cloneShallow(options.source, {
      ...(options.ref === undefined ? {} : { ref: options.ref }),
      ...(options.allowFileUrls ? { allowFileUrls: true } : {}),
      git,
    });
    log(`Cloned ${clone.displayUrl}${clone.ref ? ` (${clone.ref})` : ''} at ${clone.commit.slice(0, 12)}.`);
    try {
      return await importDirectory(options, clone.directory, undefined, {
        kind: 'git',
        url: sourceUrlForStorage(clone.displayUrl),
        ref: clone.ref,
        commit: clone.commit,
        label: clone.displayUrl,
      });
    } finally {
      await clone.cleanup();
    }
  }
  if (options.ref !== undefined) {
    throw new ImportError('--ref is only supported for Git URLs.');
  }
  const directory = resolve(options.source);
  const stats = await stat(directory).catch(() => undefined);
  if (!stats?.isDirectory()) {
    throw new ImportError(`The source "${options.source}" is neither a directory nor a Git URL.`);
  }
  const workTree = await readWorkTree(directory, { git });
  return importDirectory(options, directory, workTree?.files, {
    kind: 'directory',
    url: workTree?.url ?? null,
    ref: workTree?.ref ?? null,
    commit: workTree?.commit ?? null,
    label: directory,
    ...(workTree ? { clean: workTree.clean } : {}),
  });
}

/**
 * @param {ImportOptions} options
 * @param {string} root
 * @param {string[] | undefined} candidates
 * @param {SourceInfo} source
 * @returns {Promise<ImportResult>}
 */
async function importDirectory(options, root, candidates, source) {
  const {
    name,
    include = [],
    exclude = [],
    maxBytes = DEFAULT_MAX_BYTES,
    maxLineLength = DEFAULT_MAX_LINE_LENGTH,
    sync = false,
    dryRun = false,
    log = () => {},
  } = options;

  if (dryRun) {
    const { selected, skipped } = await selectFiles({
      root,
      ...(candidates ? { candidates } : {}),
      include,
      exclude,
      maxBytes,
      maxLineLength,
    });
    return {
      source,
      selected,
      skipped,
      summary: summarizeByExtension(selected),
      estimatedChunks: estimateChunks(selected),
      dryRun: true,
    };
  }

  const api = createApiClient({
    apiUrl: options.apiUrl ?? 'http://127.0.0.1:3000',
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    log,
  });
  const sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));

  // 1. API, limits, embedding provider.
  await api.request('GET', '/api/health');
  const info = await api.request('GET', '/api/system/info');
  const limits = {
    maxFiles: Math.max(1, Number(info?.upload?.maxFiles) || 20),
    maxFileBytes: Number(info?.upload?.maxFileBytes) || 5 * 1024 * 1024,
    maxRequestBytes: Number(info?.upload?.maxRequestBytes) || 100 * 1024 * 1024,
    maxDocumentsPerCollection:
      typeof info?.upload?.maxDocumentsPerCollection === 'number'
        ? info.upload.maxDocumentsPerCollection
        : null,
  };
  /** @type {string[]} */
  const supportedExtensions = Array.isArray(info?.upload?.allowedExtensions)
    ? info.upload.allowedExtensions
    : DEFAULT_SUPPORTED_EXTENSIONS;
  const providers = await api.request('GET', '/api/system/providers');
  const embedding = providers?.embedding;
  if (!embedding?.reachable) {
    throw new ImportError(
      `The embedding provider is not reachable from the API${embedding?.error ? ` (${embedding.error})` : ''}. ` +
        'Start Ollama and check OLLAMA_BASE_URL.',
    );
  }
  if (embedding.modelAvailable === false) {
    throw new ImportError(
      `The embedding model "${embedding.model}" is not installed in Ollama. ` +
        `Install it yourself with "ollama pull ${embedding.model}" and run the command again.`,
    );
  }

  // 2. Files.
  const { selected, skipped } = await selectFiles({
    root,
    ...(candidates ? { candidates } : {}),
    supportedExtensions,
    include,
    exclude,
    maxBytes: Math.min(maxBytes, limits.maxFileBytes),
    maxLineLength,
  });
  log(`Selected ${selected.length} files (${skipped.length} skipped).`);

  // 3. Collection and plan.
  const collections = (await api.request('GET', '/api/collections'))?.items ?? [];
  /** @type {{ id: string, name: string, embeddingModel: string } | undefined} */
  let collection = collections.find(
    (/** @type {{ name: string }} */ item) => item.name.toLowerCase() === name.toLowerCase(),
  );
  let created = false;
  if (collection) {
    if (collection.embeddingModel !== embedding.model) {
      throw new ImportError(
        `The collection "${collection.name}" was embedded with "${collection.embeddingModel}", but the ` +
          `API is configured for "${embedding.model}". Use another --name or delete the collection.`,
      );
    }
    log(`Reusing collection "${collection.name}" (${collection.id}).`);
  } else {
    collection = await api.request('POST', '/api/collections', {
      json: { name, description: `Imported from ${source.url ?? source.label} (pnpm kb:import).`.slice(0, 2000) },
    });
    created = true;
    log(`Created collection "${collection?.name}" (${collection?.id}).`);
  }
  const collectionId = /** @type {{ id: string }} */ (collection).id;
  const documentsPath = `/api/collections/${collectionId}/documents`;
  /** @type {RemoteDocument[]} */
  const existing = (await api.request('GET', documentsPath))?.items ?? [];
  const plan = planImport(selected, existing, { sync });

  if (limits.maxDocumentsPerCollection !== null) {
    const after =
      existing.length + plan.upload.length - (sync ? plan.removed.length + plan.changed.length : 0);
    if (after > limits.maxDocumentsPerCollection) {
      throw new ImportError(
        `The collection would hold ${after} documents, but the API allows at most ` +
          `${limits.maxDocumentsPerCollection} (MAX_DOCUMENTS_PER_COLLECTION). Narrow the import with ` +
          '--include/--exclude/.raglabignore or raise the limit.',
      );
    }
  }

  const changedPaths = new Set(plan.changed.map((entry) => entry.file.path));
  const newCount = plan.upload.filter((file) => !changedPaths.has(file.path)).length;
  log(
    `Plan: ${newCount} new, ${plan.unchanged.length} unchanged, ` +
      `${plan.changed.length} changed, ${plan.removed.length} no longer in the source` +
      `${plan.duplicateInCollection.length ? `, ${plan.duplicateInCollection.length} duplicate content` : ''}.`,
  );
  if (!sync && (plan.changed.length > 0 || plan.removed.length > 0)) {
    log('Changed and removed files are left as they are – run with --sync to replace and delete them.');
  }

  // 4. Sync: delete replaced and removed documents first (summary above), then upload.
  /** @type {string[]} */ const deleted = [];
  /** @type {string[]} */ const replaced = [];
  if (sync) {
    for (const { document } of plan.changed) {
      await api.request('DELETE', `/api/documents/${document.id}`);
      replaced.push(document.path ?? document.filename);
    }
    for (const document of plan.removed) {
      await api.request('DELETE', `/api/documents/${document.id}`);
      deleted.push(document.path ?? document.filename);
    }
    if (replaced.length + deleted.length > 0) {
      log(`Deleted ${deleted.length} removed and ${replaced.length} changed documents.`);
    }
  }

  /** @type {string[]} */ const reindexed = [];
  for (const document of plan.reindex) {
    try {
      await api.request('POST', `/api/documents/${document.id}/reindex`);
      reindexed.push(document.path ?? document.filename);
    } catch (error) {
      if (!(error instanceof ImportError) || error.status !== 409) throw error;
    }
  }

  const { uploaded, rejected } = await uploadAll(api, documentsPath, plan.upload, limits, log);

  // 5. Import source (after the upload, so `importedAt` marks the end of the import).
  await api.request('PUT', `/api/collections/${collectionId}/source`, {
    json: { kind: source.kind, url: source.url, ref: source.ref, commit: source.commit },
  });

  // 6. Wait for indexing of every document from this source.
  const documents = await waitForIndexing(api, documentsPath, new Set(selected.map((f) => f.path)), {
    timeoutMs: options.timeoutMs ?? 3_600_000,
    pollIntervalMs: options.pollIntervalMs ?? 2000,
    sleep,
    log,
  });

  return {
    source,
    selected,
    skipped,
    summary: summarizeByExtension(selected),
    estimatedChunks: estimateChunks(selected),
    dryRun: false,
    collection: { id: collectionId, name: /** @type {{ name: string }} */ (collection).name },
    created,
    plan,
    uploaded,
    replaced,
    deleted,
    reindexed,
    rejected,
    documents,
  };
}

/**
 * Uploads in batches. A rejected batch (4xx other than 429) is retried file by file, so one
 * invalid file does not block the others; its error is reported per file.
 * @param {ReturnType<typeof createApiClient>} api
 * @param {string} documentsPath
 * @param {SelectedFile[]} files
 * @param {{ maxFiles: number, maxRequestBytes: number }} limits
 * @param {(line: string) => void} log
 */
async function uploadAll(api, documentsPath, files, limits, log) {
  /** @type {string[]} */ const uploaded = [];
  /** @type {{ path: string, code: string, message: string }[]} */ const rejected = [];
  const batches = batchFiles(files, limits);
  /** @param {SelectedFile[]} batch */
  const formFor = (batch) => () => {
    const form = new FormData();
    for (const file of batch) {
      form.append('path', file.path);
      form.append('file', new Blob([file.content]), file.path.split('/').pop() ?? 'file');
    }
    return form;
  };
  let done = 0;
  for (const batch of batches) {
    try {
      await api.request('POST', documentsPath, { form: formFor(batch) });
      uploaded.push(...batch.map((file) => file.path));
    } catch (error) {
      if (!(error instanceof ImportError) || error.status === undefined || error.status >= 500) {
        throw error;
      }
      for (const file of batch) {
        try {
          await api.request('POST', documentsPath, { form: formFor([file]) });
          uploaded.push(file.path);
        } catch (single) {
          if (!(single instanceof ImportError) || single.status === undefined || single.status >= 500) {
            throw single;
          }
          rejected.push({ path: file.path, code: single.code ?? 'HTTP_ERROR', message: single.message });
          log(`Rejected ${file.path}: ${single.code}`);
        }
      }
    }
    done += batch.length;
    if (batches.length > 1) {
      log(`Uploaded ${done}/${files.length} files …`);
    }
  }
  return { uploaded, rejected };
}

/**
 * Polls the document list until every document with one of `paths` is `ready` or `failed`.
 * @param {ReturnType<typeof createApiClient>} api
 * @param {string} documentsPath
 * @param {Set<string>} paths
 * @param {{ timeoutMs: number, pollIntervalMs: number, sleep: (ms: number) => Promise<void>, log: (line: string) => void }} options
 * @returns {Promise<RemoteDocument[]>}
 */
async function waitForIndexing(api, documentsPath, paths, { timeoutMs, pollIntervalMs, sleep, log }) {
  const deadline = Date.now() + timeoutMs;
  let lastReport = '';
  for (;;) {
    /** @type {RemoteDocument[]} */
    const items = (await api.request('GET', documentsPath))?.items ?? [];
    const documents = items.filter((document) => document.path !== null && paths.has(document.path));
    const busy = documents.filter((d) => d.status === 'pending' || d.status === 'processing');
    if (busy.length === 0) return documents;
    if (Date.now() >= deadline) {
      throw new ImportError(
        `Indexing did not finish within ${Math.round(timeoutMs / 1000)} s (${busy.length} document(s) ` +
          'still pending/processing). Indexing continues in the API – run the command again to keep waiting.',
      );
    }
    const report = `Waiting for indexing: ${documents.length - busy.length}/${documents.length} done …`;
    if (report !== lastReport) log(report);
    lastReport = report;
    await sleep(pollIntervalMs);
  }
}
