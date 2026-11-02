import { defineConfig } from 'vitest/config';

/** Live tests against a real Ollama; only active with RAGLAB_LIVE_TESTS=1 (see README). */
export default defineConfig({
  test: {
    include: ['test/live/**/*.live.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
  },
});
