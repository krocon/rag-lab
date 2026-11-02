import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatResult, collection, COLLECTION_ID, searchResponse } from './fakes.js';

/**
 * End-to-end over stdio: the real entry point (`src/main.ts` via tsx) as a child process, a fake
 * RAGLab API as local HTTP server. Verifies that stdout carries only protocol messages, that the
 * API requests look like plain server-to-server calls (no Origin, loopback Host) and that the
 * server survives an unreachable API.
 */
const appDir = fileURLToPath(new URL('..', import.meta.url));

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let api: Server;
let apiUrl: string;
const seen: Seen[] = [];

beforeAll(async () => {
  api = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (body += chunk));
    request.on('end', () => {
      seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body,
      });
      const json = (status: number, data: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(data));
      };
      if (request.method === 'GET' && request.url === '/api/collections') {
        json(200, { items: [collection()] });
      } else if (request.method === 'POST' && request.url === '/api/retrieval/search') {
        json(200, searchResponse());
      } else if (request.method === 'POST' && request.url === '/api/chat') {
        const result = chatResult();
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        response.write(`event: sources\ndata: ${JSON.stringify({ sources: result.sources })}\n\n`);
        response.write(': heartbeat\n\n');
        response.write(`event: token\ndata: ${JSON.stringify({ text: result.answer })}\n\n`);
        response.end(`event: done\ndata: ${JSON.stringify(result.done)}\n\n`);
      } else {
        json(404, { error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found.' } });
      }
    });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

async function startServer(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/main.ts'],
    cwd: appDir,
    env,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  const protocolErrors: Error[] = [];
  client.onerror = (error) => protocolErrors.push(error);
  await client.connect(transport);
  return { client, protocolErrors, stderr: () => stderr };
}

function text(result: CallToolResult): string {
  return result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
}

describe('stdio server (child process)', () => {
  it('serves all tools against the API; stdout carries only protocol messages', async () => {
    const { client, protocolErrors, stderr } = await startServer({ RAGLAB_API_URL: apiUrl });
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(4);

      const list = (await client.callTool({ name: 'list_collections' })) as CallToolResult;
      expect(list.isError).toBeFalsy();
      expect(list.structuredContent).toMatchObject({ collections: [{ id: COLLECTION_ID }] });

      const search = (await client.callTool({
        name: 'search_knowledge',
        arguments: { collection: 'Handbook', query: 'rollback' },
      })) as CallToolResult;
      expect(search.isError).toBeFalsy();
      expect(text(search)).toContain('score 0.7500 · distance 0.2500');

      const ask = (await client.callTool({
        name: 'ask_knowledge',
        arguments: { collection: 'Handbook', question: 'How?' },
      })) as CallToolResult;
      expect(ask.isError).toBeFalsy();
      expect(ask.structuredContent).toMatchObject({ answerStatus: 'answered', citedSources: [1] });

      // Every stdout line was a valid JSON-RPC message (otherwise the transport reports an error).
      expect(protocolErrors).toEqual([]);
      expect(stderr()).toContain('RAGLab MCP server');
      expect(stderr()).not.toContain('rollback'); // no queries in logs

      const post = seen.find((request) => request.url === '/api/retrieval/search');
      expect(post?.headers.origin).toBeUndefined();
      expect(post?.headers.host).toBe(new URL(apiUrl).host);
      expect(post?.headers['content-type']).toBe('application/json');
      expect(JSON.parse(post?.body ?? '{}')).toEqual({
        collectionId: COLLECTION_ID,
        query: 'rollback',
      });
    } finally {
      await client.close();
    }
  }, 30_000);

  it('reports an unreachable API as tool error and keeps running', async () => {
    // A port that was free a moment ago: nothing listens there.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const { client, protocolErrors } = await startServer({
      RAGLAB_API_URL: `http://127.0.0.1:${port}`,
    });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = (await client.callTool({ name: 'list_collections' })) as CallToolResult;
        expect(result.isError).toBe(true);
        expect(text(result)).toContain('API_UNREACHABLE');
      }
      expect(protocolErrors).toEqual([]);
    } finally {
      await client.close();
    }
  }, 30_000);

  it('exits with a configuration error on stderr', async () => {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: appDir,
      env: { PATH: process.env['PATH'] ?? '', RAGLAB_API_URL: 'ftp://nope' },
      input: '',
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('RAGLAB_API_URL: must use http or https');
  }, 30_000);
});
