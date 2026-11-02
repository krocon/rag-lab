import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadEnvFile } from '../config/load-env-file.js';
import { createDatabase } from './client.js';

/** Applies all pending SQL migrations from ./drizzle. Usage: `pnpm db:migrate`. */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const connection = createDatabase(databaseUrl, 1);
  try {
    await migrate(connection.db, {
      migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)),
    });
  } finally {
    await connection.close();
  }
}

const isEntryPoint =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isEntryPoint) {
  loadEnvFile();
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is not set (copy .env.example to .env).');
    process.exit(1);
  }
  runMigrations(url)
    .then(() => console.log('Migrations applied.'))
    .catch((error: unknown) => {
      console.error('Migration failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
