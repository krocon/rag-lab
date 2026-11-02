import { describe, expect, it } from 'vitest';
import { availableCollections, resolveCollection } from '../src/collections.js';
import { ToolInputError } from '../src/errors.js';
import { collection, COLLECTION_ID, OTHER_COLLECTION_ID } from './fakes.js';

const collections = [
  collection(),
  collection({ id: OTHER_COLLECTION_ID, name: 'Release Notes', description: null }),
];

describe('resolveCollection', () => {
  it('finds a collection by ID (also in upper case)', () => {
    expect(resolveCollection(collections, OTHER_COLLECTION_ID).name).toBe('Release Notes');
    expect(resolveCollection(collections, COLLECTION_ID.toUpperCase()).id).toBe(COLLECTION_ID);
  });

  it('finds a collection by exact name, case-insensitively and trimmed', () => {
    expect(resolveCollection(collections, '  release notes ').id).toBe(OTHER_COLLECTION_ID);
    expect(resolveCollection(collections, 'HANDBOOK').id).toBe(COLLECTION_ID);
  });

  it('does not match partial names', () => {
    expect(() => resolveCollection(collections, 'Release')).toThrow(ToolInputError);
  });

  it('reports unknown collections with the list of available ones', () => {
    try {
      resolveCollection(collections, 'Missing');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ToolInputError);
      expect((error as ToolInputError).code).toBe('COLLECTION_NOT_FOUND');
      expect((error as Error).message).toContain('"Handbook" (id: ' + COLLECTION_ID + ')');
      expect((error as Error).message).toContain('"Release Notes"');
    }
  });

  it('reports ambiguous names', () => {
    const twins = [collection(), collection({ id: OTHER_COLLECTION_ID, name: 'HANDBOOK' })];
    try {
      resolveCollection(twins, 'handbook');
      expect.unreachable();
    } catch (error) {
      expect((error as ToolInputError).code).toBe('COLLECTION_AMBIGUOUS');
      expect((error as Error).message).toContain(OTHER_COLLECTION_ID);
    }
  });
});

describe('availableCollections', () => {
  it('explains an empty instance and limits long lists', () => {
    expect(availableCollections([])).toContain('no collections yet');
    const many = Array.from({ length: 55 }, (_, index) => collection({ name: `c${index}` }));
    const text = availableCollections(many);
    expect(text).toContain('"c49"');
    expect(text).not.toContain('"c50"');
    expect(text).toContain('… and 5 more');
  });
});
