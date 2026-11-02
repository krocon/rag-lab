// @ts-check
/**
 * Logic of `pnpm demo:seed` (scripts/demo-seed.mjs): loads the demo knowledge base into RAGLab
 * through the public REST API only – the same calls a user could make with curl.
 *
 *   1. checks that the API is reachable and that the embedding provider (Ollama) is reachable and
 *      has the configured model installed,
 *   2. reuses the collection with the given name (case-insensitive) or creates it; `reset` deletes
 *      an existing one first,
 *   3. uploads every file that is not in the collection yet (one request per file, so one
 *      duplicate does not reject the others) and reindexes demo documents that had failed,
 *   4. polls the document list until every demo document is `ready` or `failed`.
 *
 * Running it twice is safe: the second run uploads nothing and only reports the status. Rate-limit
 * responses (429) are retried after the `Retry-After` the API sends.
 * `fetch`, `sleep` and `log` are parameters so the unit tests can replace them.
 */

/** An error with a message meant for the user of the command (no stack trace needed). */
export class SeedError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, retryAfterSeconds?: number }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'SeedError';
    this.status = details.status;
    this.code = details.code;
    this.retryAfterSeconds = details.retryAfterSeconds;
  }
}

/**
 * @typedef {{ name: string, content: string }} SeedFile
 * @typedef {{ id: string, filename: string, status: string, errorMessage: string | null, chunkCount: number }} SeedDocument
 * @typedef {{ id: string, name: string, embeddingModel: string }} SeedCollection
 * @typedef {{
 *   apiUrl: string,
 *   name: string,
 *   description?: string,
 *   files: SeedFile[],
 *   reset?: boolean,
 *   timeoutMs?: number,
 *   pollIntervalMs?: number,
 *   requestTimeoutMs?: number,
 *   maxRateLimitRetries?: number,
 *   fetch?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: (line: string) => void,
 * }} SeedOptions
 * @typedef {{
 *   collection: SeedCollection,
 *   created: boolean,
 *   deleted: boolean,
 *   uploaded: string[],
 *   skipped: string[],
 *   reindexed: string[],
 *   documents: SeedDocument[],
 * }} SeedResult
 */

/** Content type sent for an upload; the API derives the document type from the extension. */
export function contentTypeFor(filename) {
  return /\.txt$/i.test(filename) ? 'text/plain' : 'text/markdown';
}

/** Removes a trailing slash so paths can be appended (`http://host:3000/` → `http://host:3000`). */
export function normaliseApiUrl(apiUrl) {
  let url;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new SeedError(`Invalid API URL "${apiUrl}" – expected e.g. http://127.0.0.1:3000`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SeedError(`Invalid API URL "${apiUrl}" – only http and https are supported`);
  }
  return url.href.replace(/\/+$/, '');
}

/**
 * @param {SeedOptions} options
 * @returns {Promise<SeedResult>}
 */
export async function seedDemo(options) {
  const {
    name,
    description,
    files,
    reset = false,
    timeoutMs = 300_000,
    pollIntervalMs = 1000,
    requestTimeoutMs = 30_000,
    maxRateLimitRetries = 5,
    fetch: fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = () => {},
  } = options;
  const apiUrl = normaliseApiUrl(options.apiUrl);
  if (files.length === 0) throw new SeedError('No demo files found to upload.');

  /**
   * One API call. Network errors and non-2xx responses become a SeedError with the API's error
   * code and message (`{ error: { code, message } }`).
   * @param {string} method
   * @param {string} path
   * @param {{ json?: unknown, form?: FormData }} [body]
   */
  async function api(method, path, body = {}) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await apiOnce(method, path, body);
      } catch (error) {
        // Rate limited (429 RATE_LIMITED, e.g. RATE_LIMIT_UPLOAD_MAX uploads per minute): wait as
        // long as the API asks (Retry-After) and try again, a few times at most.
        if (
          !(error instanceof SeedError) ||
          error.status !== 429 ||
          attempt > maxRateLimitRetries
        ) {
          throw error;
        }
        const waitSeconds = error.retryAfterSeconds ?? 10;
        log(`Rate limited by the API – waiting ${waitSeconds} s before trying again …`);
        await sleep(waitSeconds * 1000);
      }
    }
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ json?: unknown, form?: FormData }} body
   */
  async function apiOnce(method, path, body) {
    /** @type {RequestInit} */
    const init = { method, signal: AbortSignal.timeout(requestTimeoutMs) };
    if (body.json !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body.json);
    } else if (body.form) {
      init.body = body.form;
    }
    let response;
    try {
      response = await fetchImpl(`${apiUrl}${path}`, init);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SeedError(
        `The RAGLab API is not reachable at ${apiUrl} (${reason}). Start it with "pnpm dev" ` +
          'or "docker compose --profile app up -d", or pass --api-url.',
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
      throw new SeedError(`${method} ${path} failed with ${response.status} ${code}: ${message}`, {
        status: response.status,
        code,
        retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      });
    }
    return data;
  }

  // 1. API and embedding provider.
  await api('GET', '/api/health');
  const providers = await api('GET', '/api/system/providers');
  const embedding = providers?.embedding;
  if (!embedding?.reachable) {
    throw new SeedError(
      `The embedding provider is not reachable from the API${embedding?.error ? ` (${embedding.error})` : ''}. ` +
        'Start Ollama and check OLLAMA_BASE_URL (OLLAMA_DOCKER_BASE_URL for the Docker stack).',
    );
  }
  if (embedding.modelAvailable === false) {
    throw new SeedError(
      `The embedding model "${embedding.model}" is not installed in Ollama. ` +
        `Install it yourself with "ollama pull ${embedding.model}" and run the command again.`,
    );
  }
  if (providers?.chat && providers.chat.modelAvailable === false) {
    log(
      `Note: the chat model "${providers.chat.model}" is not installed – indexing and the ` +
        `playground work, chat answers need "ollama pull ${providers.chat.model}".`,
    );
  }

  // 2. Collection.
  const list = await api('GET', '/api/collections');
  /** @type {SeedCollection | undefined} */
  let collection = (list?.items ?? []).find(
    (/** @type {SeedCollection} */ item) => item.name.toLowerCase() === name.toLowerCase(),
  );
  let deleted = false;
  if (collection && reset) {
    await api('DELETE', `/api/collections/${collection.id}`);
    log(`Deleted collection "${collection.name}" (${collection.id}).`);
    collection = undefined;
    deleted = true;
  }
  let created = false;
  if (collection) {
    if (collection.embeddingModel !== embedding.model) {
      throw new SeedError(
        `The collection "${collection.name}" was embedded with "${collection.embeddingModel}", but ` +
          `the API is configured for "${embedding.model}". Run the command with --reset to rebuild it.`,
      );
    }
    log(`Reusing collection "${collection.name}" (${collection.id}).`);
  } else {
    collection = await api('POST', '/api/collections', {
      json: description ? { name, description } : { name },
    });
    created = true;
    log(`Created collection "${collection?.name}" (${collection?.id}).`);
  }
  const collectionId = /** @type {SeedCollection} */ (collection).id;

  // 3. Upload missing files, reindex failed demo documents.
  const documentsPath = `/api/collections/${collectionId}/documents`;
  /** @type {SeedDocument[]} */
  const existing = (await api('GET', documentsPath))?.items ?? [];
  const byName = new Map(existing.map((document) => [document.filename, document]));
  /** @type {string[]} */ const uploaded = [];
  /** @type {string[]} */ const skipped = [];
  /** @type {string[]} */ const reindexed = [];
  for (const file of files) {
    const present = byName.get(file.name);
    if (present) {
      if (present.status === 'failed') {
        await api('POST', `/api/documents/${present.id}/reindex`);
        reindexed.push(file.name);
        log(`Reindexing ${file.name} (it had failed: ${present.errorMessage ?? 'unknown error'}).`);
      } else {
        skipped.push(file.name);
      }
      continue;
    }
    const form = new FormData();
    form.append('file', new Blob([file.content], { type: contentTypeFor(file.name) }), file.name);
    try {
      await api('POST', documentsPath, { form });
      uploaded.push(file.name);
      log(`Uploaded ${file.name}.`);
    } catch (error) {
      if (error instanceof SeedError && error.code === 'DUPLICATE_DOCUMENT') {
        skipped.push(file.name);
        log(`Skipped ${file.name}: the same content is already in the collection.`);
      } else {
        throw error;
      }
    }
  }
  if (uploaded.length === 0 && reindexed.length === 0) {
    log('All demo files are already in the collection – nothing to upload.');
  }

  // 4. Wait for indexing.
  const names = new Set(files.map((file) => file.name));
  const deadline = Date.now() + timeoutMs;
  /** @type {SeedDocument[]} */
  let documents;
  for (;;) {
    /** @type {SeedDocument[]} */
    const items = (await api('GET', documentsPath))?.items ?? [];
    documents = items.filter((document) => names.has(document.filename));
    const busy = documents.filter(
      (document) => document.status === 'pending' || document.status === 'processing',
    );
    if (busy.length === 0) break;
    if (Date.now() >= deadline) {
      throw new SeedError(
        `Indexing did not finish within ${Math.round(timeoutMs / 1000)} s ` +
          `(${busy.length} document(s) still pending/processing). The first request after starting ` +
          'Ollama loads the model; run the command again to keep waiting.',
      );
    }
    log(`Waiting for indexing: ${documents.length - busy.length}/${documents.length} done …`);
    await sleep(pollIntervalMs);
  }

  return {
    collection: /** @type {SeedCollection} */ (collection),
    created,
    deleted,
    uploaded,
    skipped,
    reindexed,
    documents,
  };
}
