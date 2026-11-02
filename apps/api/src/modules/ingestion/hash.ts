import { createHash } from 'node:crypto';

/** SHA-256 of the UTF-8 encoded text as lower-case hex (64 characters). */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
