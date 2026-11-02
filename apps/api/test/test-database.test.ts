import { describe, expect, it } from 'vitest';
import { databaseName, resolveTestDatabase, sameDatabase } from './integration/test-database.js';

const DEV = 'postgresql://raglab:secret@localhost:5432/raglab';

describe('resolveTestDatabase (guard for pnpm test:integration)', () => {
  it('derives <name>_test on the same server when TEST_DATABASE_URL is unset', () => {
    expect(resolveTestDatabase({ DATABASE_URL: DEV })).toEqual({
      url: 'postgresql://raglab:secret@localhost:5432/raglab_test',
      databaseName: 'raglab_test',
      source: 'derived from DATABASE_URL',
    });
  });

  it('keeps query parameters when deriving', () => {
    const target = resolveTestDatabase({ DATABASE_URL: `${DEV}?sslmode=disable` });
    expect(target.url).toBe(
      'postgresql://raglab:secret@localhost:5432/raglab_test?sslmode=disable',
    );
  });

  it('uses TEST_DATABASE_URL when set', () => {
    const url = 'postgresql://ci:ci@db:5433/raglab_ci_test';
    expect(resolveTestDatabase({ DATABASE_URL: DEV, TEST_DATABASE_URL: url })).toMatchObject({
      url,
      databaseName: 'raglab_ci_test',
      source: 'TEST_DATABASE_URL',
    });
  });

  it('works with TEST_DATABASE_URL alone', () => {
    const url = 'postgresql://ci:ci@db/test_db';
    expect(resolveTestDatabase({ TEST_DATABASE_URL: url }).url).toBe(url);
  });

  it('refuses the development database as TEST_DATABASE_URL', () => {
    expect(() =>
      resolveTestDatabase({ DATABASE_URL: DEV, TEST_DATABASE_URL: DEV.replace('secret', 'x') }),
    ).toThrow(/must\s+contain "test"/);
  });

  it('refuses TEST_DATABASE_URL equal to DATABASE_URL even if the name contains "test"', () => {
    const url = 'postgresql://raglab:secret@localhost/raglab_test';
    expect(() => resolveTestDatabase({ DATABASE_URL: url, TEST_DATABASE_URL: url })).toThrow(
      /database of DATABASE_URL/,
    );
  });

  it('refuses database names without "test"', () => {
    expect(() =>
      resolveTestDatabase({ TEST_DATABASE_URL: 'postgresql://u:p@localhost/production' }),
    ).toThrow(/Refusing/);
  });

  it('fails clearly without any database URL', () => {
    expect(() => resolveTestDatabase({})).toThrow(/TEST_DATABASE_URL nor DATABASE_URL/);
  });
});

describe('database URL helpers', () => {
  it('reads the database name', () => {
    expect(databaseName('postgres://u@h:1/my%20db')).toBe('my db');
    expect(() => databaseName('postgres://u@h:1/')).toThrow(/no database name/);
  });

  it('compares host, default port and name', () => {
    expect(sameDatabase('postgres://a@LOCALHOST/x', 'postgres://b@localhost:5432/x')).toBe(true);
    expect(sameDatabase('postgres://a@localhost/x', 'postgres://a@localhost:5433/x')).toBe(false);
    expect(sameDatabase('postgres://a@localhost/x', 'postgres://a@localhost/y')).toBe(false);
  });
});
