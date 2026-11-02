import { defineConfig } from 'vitest/config';

/**
 * Integration tests need a running PostgreSQL with pgvector (`pnpm db:up`). They run against a
 * dedicated test database (TEST_DATABASE_URL or `<DATABASE_URL name>_test`), which the global
 * setup creates and migrates – never against the development database.
 */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.int.test.ts'],
    environment: 'node',
    globalSetup: ['test/integration/global-setup.ts'],
    testTimeout: 20_000,
    fileParallelism: false,
  },
});
