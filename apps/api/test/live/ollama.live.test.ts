import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { loadEnvFile } from '../../src/config/load-env-file.js';
import { createChatProvider } from '../../src/modules/chat/create-chat-provider.js';
import { createEmbeddingProvider } from '../../src/modules/embeddings/create-embedding-provider.js';

/**
 * Optional check against a real Ollama with the configured model (`.env`). Not part of
 * `pnpm test` or CI. Run: `RAGLAB_LIVE_TESTS=1 pnpm --filter @raglab/api test:live`
 * (requires e.g. `ollama pull nomic-embed-text` and `ollama pull llama3.2`).
 */
const live = process.env['RAGLAB_LIVE_TESTS'] === '1';

describe.skipIf(!live)('Ollama embedding provider (live)', () => {
  it('has the configured model and returns vectors of EMBEDDING_DIMENSIONS', async () => {
    loadEnvFile();
    const config = loadConfig();
    const provider = createEmbeddingProvider(config);

    const status = await provider.checkStatus();
    expect(status, status.hint).toMatchObject({ reachable: true, modelAvailable: true });

    const vectors = await provider.embed(['RAGLab live test', 'A second text']);
    expect(vectors).toHaveLength(2);
    for (const vector of vectors) {
      expect(vector).toHaveLength(config.embedding.dimensions);
    }
  });
});

describe.skipIf(!live)('Ollama chat provider (live)', () => {
  it('has the configured chat model and streams an answer', async () => {
    loadEnvFile();
    const config = loadConfig();
    const provider = createChatProvider(config);

    const status = await provider.checkStatus();
    expect(status, status.hint).toMatchObject({ reachable: true, modelAvailable: true });

    const pieces: string[] = [];
    for await (const text of provider.stream([
      { role: 'system', content: 'Answer with one short sentence.' },
      { role: 'user', content: 'Say hello.' },
    ])) {
      pieces.push(text);
    }
    expect(pieces.join('').trim().length).toBeGreaterThan(0);
  });
});
