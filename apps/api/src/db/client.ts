import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseConnection {
  pool: pg.Pool;
  db: Database;
  close(): Promise<void>;
}

export function createDatabase(url: string, poolMax = 10): DatabaseConnection {
  const pool = new pg.Pool({ connectionString: url, max: poolMax });
  const db = drizzle(pool, { schema });
  return { pool, db, close: () => pool.end() };
}
