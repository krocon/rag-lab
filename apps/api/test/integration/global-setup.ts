import { loadEnvFile } from '../../src/config/load-env-file.js';
import { runMigrations } from '../../src/db/migrate.js';
import { ensureTestDatabase, resolveTestDatabase } from './test-database.js';

/**
 * Vitest global setup of `pnpm test:integration`: resolves the dedicated test database (never the
 * development database, see test-database.ts), creates it if needed and applies the migrations.
 */
export default async function setup(): Promise<void> {
  loadEnvFile();
  try {
    const target = resolveTestDatabase(process.env);
    const state = await ensureTestDatabase(target, process.env['DATABASE_URL']);
    await runMigrations(target.url);
    console.log(
      `Integration tests use database "${target.databaseName}" (${target.source}, ${state}).`,
    );
  } catch (error) {
    // Vitest's stack-trace handling garbles errors thrown from a global setup; print the
    // message itself and stop before any test can touch a database.
    console.error(
      `\nIntegration tests not started: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
