import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Loads the repository-root `.env` (if present) into process.env.
 * Variables that are already set win, so Docker/CI environments are never overridden.
 */
export function loadEnvFile(
  path = fileURLToPath(new URL('../../../../.env', import.meta.url)),
): void {
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}
