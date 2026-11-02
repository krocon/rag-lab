import { defineConfig } from 'vitest/config';

/** Integration tests need a running PostgreSQL with pgvector (see README → Testing). */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.int.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    fileParallelism: false,
  },
});
