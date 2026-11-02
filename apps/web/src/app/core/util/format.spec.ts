import { fileExtension, formatBytes, plural } from './format';

describe('format helpers', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1 KiB'],
    [1536, '1.5 KiB'],
    [5 * 1024 * 1024, '5 MiB'],
    [6.25 * 1024 * 1024, '6.3 MiB'],
  ])('formatBytes(%i) = %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it('extracts lower-case extensions', () => {
    expect(fileExtension('Notes.MD')).toBe('.md');
    expect(fileExtension('archive.tar.gz')).toBe('.gz');
    expect(fileExtension('README')).toBe('');
    expect(fileExtension('.hidden')).toBe('');
  });

  it('pluralizes counts', () => {
    expect(plural(1, 'chunk')).toBe('1 chunk');
    expect(plural(0, 'chunk')).toBe('0 chunks');
  });
});
