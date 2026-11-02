#!/usr/bin/env node
// @ts-check
/**
 * Docker smoke test of the complete stack (CI job "docker", docs/release.md):
 *
 *   node scripts/docker-smoke.mjs [--no-build] [--keep] [--skip-mcp]
 *
 * 1. Starts a fake Ollama on the host (scripts/docker-smoke/fake-ollama.mjs; no real model needed).
 * 2. `docker compose --profile app up -d --build --wait` with the API pointed at the fake:
 *    postgres → migrate (one-shot) → api → web, all health checks healthy.
 * 3. Checks through the web container on http://localhost:8080: health, SPA fallback, security and
 *    cache headers, gzip, readiness via the /api proxy, non-root users, no dev dependencies and no
 *    .env in the images, and upload → indexing → chat with SSE streamed through nginx **without
 *    buffering** (the first token must arrive well before the end of the answer).
 * 4. MCP image: initialize + list_collections over stdio (`docker compose run --rm -T mcp`).
 * 5. Removes its test collection and the migrate/api/web containers (postgres keeps running and
 *    its volume is untouched). --keep leaves the app containers running.
 *
 * Needs Docker with Compose and a `.env` (cp .env.example .env). The smoke test overrides the AI
 * provider settings for its own containers only, so start the stack again afterwards with your
 * normal settings (`docker compose --profile app up -d`).
 */
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createFakeOllama } from './docker-smoke/fake-ollama.mjs';

const { values: flags } = parseArgs({
  options: {
    'no-build': { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    'skip-mcp': { type: 'boolean', default: false },
  },
});

const WEB = process.env['SMOKE_WEB_URL'] ?? 'http://localhost:8080';
const API = process.env['SMOKE_API_URL'] ?? 'http://localhost:3000';
const FAKE_PORT = Number(process.env['SMOKE_OLLAMA_PORT'] ?? 11499);
const TOKEN_DELAY_MS = 400;
const smokeEnv = {
  ...process.env,
  OLLAMA_DOCKER_BASE_URL: `http://host.docker.internal:${FAKE_PORT}`,
  EMBEDDING_PROVIDER: 'ollama',
  EMBEDDING_MODEL: 'smoke-embed',
  EMBEDDING_DIMENSIONS: '768',
  CHAT_PROVIDER: 'ollama',
  CHAT_MODEL: 'smoke-chat',
};

let failures = 0;
/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` – ${detail}` : ''}`);
  if (!ok) failures++;
}

/** @param {string[]} args @param {{ input?: string, allowFailure?: boolean }} [options] */
function compose(args, options = {}) {
  const result = spawnSync('docker', ['compose', ...args], {
    env: smokeEnv,
    input: options.input,
    encoding: 'utf8',
    stdio: options.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`docker compose ${args.join(' ')} failed:\n${result.stderr}${result.stdout}`);
  }
  return result.stdout.trim();
}

/** @param {() => Promise<boolean>} condition @param {number} timeoutMs */
async function waitFor(condition, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await condition().catch(() => false)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function checkWeb() {
  console.log('Web container (nginx)');
  const health = await fetch(`${WEB}/healthz`);
  check('GET /healthz', health.status === 200);

  const index = await fetch(`${WEB}/`);
  const html = await index.text();
  check('GET / serves the Angular app', index.status === 200 && html.includes('<rl-root'));
  const csp = index.headers.get('content-security-policy') ?? '';
  check(
    'CSP header on the app',
    csp.includes("script-src 'self'") && csp.includes("frame-ancestors 'none'"),
  );
  check('index.html is revalidated', index.headers.get('cache-control') === 'no-cache');
  check('X-Content-Type-Options', index.headers.get('x-content-type-options') === 'nosniff');

  const route = await fetch(`${WEB}/knowledge-bases`);
  check(
    'SPA fallback for client routes',
    route.status === 200 && (await route.text()).includes('<rl-root'),
  );

  const script = /src="(main-[^"]+\.js)"/.exec(html)?.[1];
  check('hashed main bundle referenced', script !== undefined, script);
  if (script) {
    const asset = await fetch(`${WEB}/${script}`, { headers: { 'accept-encoding': 'gzip' } });
    await asset.arrayBuffer();
    check(
      'hashed asset cached immutable',
      (asset.headers.get('cache-control') ?? '').includes('immutable'),
    );
    check('hashed asset keeps security headers', asset.headers.has('content-security-policy'));
    check('gzip for JavaScript', asset.headers.get('content-encoding') === 'gzip');
  }
}

async function checkApi() {
  console.log('API through the proxy');
  const ready = await fetch(`${WEB}/api/health/ready`);
  const body = /** @type {{ status?: string }} */ (await ready.json());
  check(
    'GET /api/health/ready via nginx',
    ready.status === 200 && body.status === 'ready',
    JSON.stringify(body),
  );
  check(
    'API security headers pass through',
    (await fetch(`${WEB}/api/health`)).headers.has('content-security-policy'),
  );
  const direct = await fetch(`${API}/api/health`);
  check('API port published on 127.0.0.1:3000', direct.status === 200);
}

function checkContainers() {
  console.log('Containers');
  const rows = compose([
    '--profile',
    'app',
    'ps',
    '--all',
    '--format',
    '{{.Service}} {{.State}} {{.Health}} {{.ExitCode}}',
  ])
    .split('\n')
    .map((line) => line.split(' '));
  for (const service of ['postgres', 'api', 'web']) {
    const row = rows.find((r) => r[0] === service);
    check(`${service} healthy`, row?.[1] === 'running' && row?.[2] === 'healthy', row?.join(' '));
  }
  const migrate = rows.find((r) => r[0] === 'migrate');
  check(
    'migrate ran once and exited 0',
    migrate?.[1] === 'exited' && migrate?.[3] === '0',
    migrate?.join(' '),
  );

  check('api runs as uid 1000 (node)', compose(['exec', '-T', 'api', 'id', '-u']) === '1000');
  check('web runs as uid 101 (nginx)', compose(['exec', '-T', 'web', 'id', '-u']) === '101');
  const apiFiles = compose([
    'exec',
    '-T',
    'api',
    'sh',
    '-c',
    'ls -A /app; ls /app/node_modules/.pnpm | grep -E "^(vitest|tsx|typescript|drizzle-kit|@types)" || true; command -v npm || true',
  ]);
  check(
    'api image: only package.json, node_modules, dist, drizzle',
    apiFiles.split('\n').slice(0, 4).sort().join(',') === 'dist,drizzle,node_modules,package.json',
    apiFiles.replace(/\n/g, ' '),
  );
  check(
    'api image: no dev dependencies, no npm, no .env',
    apiFiles.split('\n').length === 4,
    apiFiles.replace(/\n/g, ' '),
  );
  const readOnly = compose([
    'exec',
    '-T',
    'api',
    'sh',
    '-c',
    'touch /app/x 2>/dev/null && echo writable || echo read-only',
  ]);
  check('api root file system read-only', readOnly === 'read-only');
}

async function checkChatStreaming() {
  console.log('Upload → indexing → chat (SSE through nginx)');
  const name = `docker-smoke-${Date.now()}`;
  const created = await fetch(`${WEB}/api/collections`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, description: 'Created by scripts/docker-smoke.mjs' }),
  });
  const collection = /** @type {{ id: string }} */ (await created.json());
  check('create collection', created.status === 201, `HTTP ${created.status}`);
  if (created.status !== 201) return;
  try {
    const form = new FormData();
    const text = '# Containers\n\nRAGLab runs in containers: postgres, migrate, api and web.\n';
    form.append('file', new Blob([text], { type: 'text/markdown' }), 'smoke.md');
    const upload = await fetch(`${WEB}/api/collections/${collection.id}/documents`, {
      method: 'POST',
      body: form,
    });
    const uploaded = /** @type {{ documents: { id: string }[] }} */ (await upload.json());
    check('upload document (202)', upload.status === 202, `HTTP ${upload.status}`);
    const documentId = uploaded.documents?.[0]?.id;
    const indexed = await waitFor(async () => {
      const doc = /** @type {{ status: string }} */ (
        await (await fetch(`${WEB}/api/documents/${documentId}`)).json()
      );
      if (doc.status === 'failed') throw new Error('indexing failed');
      return doc.status === 'ready';
    }, 30_000);
    check('document indexed (fake embeddings)', indexed);

    const started = Date.now();
    const chat = await fetch(`${WEB}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ collectionId: collection.id, question: 'Where does RAGLab run?' }),
    });
    check(
      'chat responds with text/event-stream',
      (chat.headers.get('content-type') ?? '').startsWith('text/event-stream'),
    );
    /** @type {{ event: string, at: number, data: string }[]} */
    const events = [];
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (chat.body ?? [])) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1] ?? 'message';
        events.push({
          event,
          at: Date.now() - started,
          data: /^data: (.*)$/m.exec(block)?.[1] ?? '',
        });
      }
    }
    const firstToken = events.find((e) => e.event === 'token');
    const done = events.find((e) => e.event === 'done');
    check(
      'events: sources → token… → done',
      events[0]?.event === 'sources' && firstToken !== undefined && done !== undefined,
      events.map((e) => e.event).join(','),
    );
    check(
      'answer grounded in the uploaded document',
      (done?.data ?? '').includes('"answerStatus":"answered"'),
      done?.data,
    );
    // The fake model needs 5 × TOKEN_DELAY_MS for the whole answer; with buffering, every event
    // would arrive together at the end.
    const gap = (done?.at ?? 0) - (firstToken?.at ?? 0);
    check(
      'SSE not buffered by the proxy',
      gap >= TOKEN_DELAY_MS * 3,
      `first token at ${firstToken?.at} ms, done at ${done?.at} ms`,
    );
  } finally {
    const removed = await fetch(`${WEB}/api/collections/${collection.id}`, { method: 'DELETE' });
    check('delete test collection', removed.status === 204, `HTTP ${removed.status}`);
  }
}

async function checkMcp() {
  console.log('MCP image (stdio)');
  const child = spawn(
    'docker',
    ['compose', '--profile', 'mcp', 'run', '--rm', '-T', '--no-deps', 'mcp'],
    {
      env: smokeEnv,
      stdio: ['pipe', 'pipe', 'inherit'],
    },
  );
  /** @type {Map<number, any>} */
  const responses = new Map();
  let buffer = '';
  /** @type {(value?: unknown) => void} */
  let notify = () => {};
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line) {
        const message = JSON.parse(line);
        if (typeof message.id === 'number') responses.set(message.id, message);
        notify();
      }
    }
  });
  /** @param {number} id */
  const response = async (id) => {
    const end = Date.now() + 60_000;
    while (!responses.has(id) && Date.now() < end) {
      await new Promise((resolve) => {
        notify = resolve;
        setTimeout(resolve, 1000);
      });
    }
    return responses.get(id);
  };
  /** @param {object} message */
  const send = (message) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  try {
    send({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'docker-smoke', version: '1.0.0' },
      },
    });
    const init = await response(1);
    check(
      'MCP initialize',
      init?.result?.serverInfo?.name === 'raglab',
      JSON.stringify(init?.result?.serverInfo),
    );
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/call', params: { name: 'list_collections', arguments: {} } });
    const list = await response(2);
    check(
      'MCP list_collections reaches the API',
      list?.result !== undefined && list.result.isError !== true,
      String(JSON.stringify(list)).slice(0, 200),
    );
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once('exit', resolve));
  }
  check(
    'MCP runs as non-root',
    compose([
      '--profile',
      'mcp',
      'run',
      '--rm',
      '-T',
      '--no-deps',
      '--entrypoint',
      'id',
      'mcp',
      '-u',
    ]) === '1000',
  );
}

async function main() {
  const fake = createFakeOllama({
    embedModel: 'smoke-embed',
    chatModel: 'smoke-chat',
    dimensions: 768,
    tokenDelayMs: TOKEN_DELAY_MS,
  });
  // Containers reach the host through host.docker.internal: on Linux that is the bridge gateway
  // (listen on all interfaces), Docker Desktop forwards it to the host's loopback.
  const host = process.platform === 'linux' ? '0.0.0.0' : '127.0.0.1';
  await new Promise((resolve) => fake.listen(FAKE_PORT, host, () => resolve(undefined)));
  console.log(`Fake Ollama on port ${FAKE_PORT}`);
  try {
    compose(['config', '-q']);
    if (!flags['no-build']) {
      console.log('Building images …');
      compose(['--profile', 'app', '--profile', 'mcp', 'build']);
    }
    console.log('Starting the stack …');
    // Compose recreates the api container because its provider settings differ; postgres stays.
    compose([
      '--profile',
      'app',
      'up',
      '-d',
      '--no-build',
      '--wait',
      '--wait-timeout',
      '180',
      'migrate',
      'api',
      'web',
    ]);
    await checkWeb();
    await checkApi();
    checkContainers();
    await checkChatStreaming();
    if (!flags['skip-mcp']) await checkMcp();
  } catch (error) {
    failures++;
    console.error(error instanceof Error ? error.message : error);
    console.error(
      compose(['--profile', 'app', 'logs', '--tail', '50', 'migrate', 'api', 'web'], {
        allowFailure: true,
      }),
    );
  } finally {
    if (!flags.keep) {
      console.log('Removing migrate/api/web containers (postgres keeps running) …');
      compose(['--profile', 'app', 'rm', '--stop', '--force', 'migrate', 'api', 'web'], {
        allowFailure: true,
      });
    }
    fake.close();
    fake.closeAllConnections();
  }
  console.log(
    failures === 0
      ? '\nDocker smoke test passed.'
      : `\nDocker smoke test FAILED (${failures} problem(s)).`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

await main();
