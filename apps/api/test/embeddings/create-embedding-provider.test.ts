import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createEmbeddingProvider } from '../../src/modules/embeddings/create-embedding-provider.js';
import { OllamaEmbeddingProvider } from '../../src/modules/embeddings/ollama-embedding-provider.js';
import { testConfig } from '../helpers.js';

describe('createEmbeddingProvider', () => {
  it('creates the Ollama adapter from the configuration', async () => {
    const config = testConfig({
      OLLAMA_BASE_URL: 'http://ollama.test:1234',
      EMBEDDING_MODEL: 'nomic-embed-text',
      EMBEDDING_BATCH_SIZE: '1',
    });
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ embeddings: [new Array(768).fill(0.5)] }));
    }) as typeof fetch;

    const provider = createEmbeddingProvider(config, { fetch: fetchImpl });
    await provider.embed(['a', 'b']);

    expect(provider).toBeInstanceOf(OllamaEmbeddingProvider);
    expect(provider).toMatchObject({ id: 'ollama', model: 'nomic-embed-text', dimensions: 768 });
    // Batch size 1 from the configuration → two requests.
    expect(urls).toEqual([
      'http://ollama.test:1234/api/embed',
      'http://ollama.test:1234/api/embed',
    ]);
  });
});

describe('provider neutrality', () => {
  const srcDir = fileURLToPath(new URL('../../src', import.meta.url));

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
    });
  }

  it('mentions the provider id "ollama" only in the factories, the adapters and the configuration', () => {
    const allowed = new Set([
      'config/env.ts',
      'modules/chat/create-chat-provider.ts',
      'modules/embeddings/create-embedding-provider.ts',
      'modules/embeddings/ollama-embedding-provider.ts',
    ]);
    const offenders = sourceFiles(srcDir)
      .map((path) => relative(srcDir, path).split('\\').join('/'))
      .filter((path) => !allowed.has(path))
      .filter((path) => /['"`]ollama['"`]/.test(readFileSync(join(srcDir, path), 'utf8')));

    expect(offenders).toEqual([]);
  });
});
