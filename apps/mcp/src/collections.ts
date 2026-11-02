import type { CollectionDto } from '@raglab/shared';
import { ToolInputError } from './errors.js';

/** At most this many collection names are listed in an error message. */
const MAX_LISTED = 50;

/**
 * Finds a collection by ID or name. Order: exact ID, then name compared case-insensitively
 * (after trimming). No match → `COLLECTION_NOT_FOUND`, more than one name match →
 * `COLLECTION_AMBIGUOUS`; both list the available collections so the model can retry.
 */
export function resolveCollection(collections: CollectionDto[], reference: string): CollectionDto {
  const wanted = reference.trim();
  const byId = collections.find((collection) => collection.id === wanted.toLowerCase());
  if (byId) {
    return byId;
  }
  const key = wanted.toLowerCase();
  const matches = collections.filter((collection) => collection.name.toLowerCase() === key);
  if (matches.length === 1 && matches[0]) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new ToolInputError(
      'COLLECTION_AMBIGUOUS',
      `The name "${wanted}" matches several collections; use the ID instead.\n` +
        availableCollections(matches),
    );
  }
  throw new ToolInputError(
    'COLLECTION_NOT_FOUND',
    `No collection with the ID or name "${wanted}".\n` + availableCollections(collections),
  );
}

export function availableCollections(collections: CollectionDto[]): string {
  if (collections.length === 0) {
    return 'There are no collections yet. Create one in the RAGLab web app.';
  }
  const listed = collections
    .slice(0, MAX_LISTED)
    .map((collection) => `- ${JSON.stringify(collection.name)} (id: ${collection.id})`);
  const more =
    collections.length > MAX_LISTED ? [`… and ${collections.length - MAX_LISTED} more`] : [];
  return ['Available collections:', ...listed, ...more].join('\n');
}
