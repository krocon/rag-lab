import type { ApiErrorResponse, UploadDocumentsResponse } from '@raglab/shared';
import { describe, expect, it } from 'vitest';
import { controlCharacterRatio, decodeUtf8 } from '../../src/modules/ingestion/decode.js';
import { sanitizeFilename } from '../../src/modules/ingestion/file-type.js';
import { multipart, type MultipartFilePart } from '../multipart.js';
import { startApp } from './setup.js';

const LIMITS = { MAX_UPLOAD_BYTES: '4096', MAX_UPLOAD_FILES: '3' };

async function upload(env: NodeJS.ProcessEnv, files: MultipartFilePart[]) {
  const started = await startApp({ env: { ...LIMITS, ...env } });
  const { payload, headers } = multipart(files);
  const response = await started.api.inject({
    method: 'POST',
    url: `/api/collections/${started.collectionId}/documents`,
    payload,
    headers,
  });
  return { ...started, response };
}

describe('filename sanitisation', () => {
  it.each([
    ['../../etc/passwd.md', 'passwd.md'],
    ['C:\\Users\\me\\notes.md', 'notes.md'],
    ['report\u202Edm.exe', 'reportdm.exe'], // right-to-left override
    ['\u2066invoice\u2069.md', 'invoice.md'], // bidi isolates
    ['a\u061Cb.md', 'ab.md'], // Arabic letter mark
    ['zero\u200Bwidth\u2060.md', 'zerowidth.md'],
    ['soft\u00ADhyphen.md', 'softhyphen.md'],
    ['bom\uFEFF.md', 'bom.md'],
    ['line\u2028break\nname\r.md', 'linebreakname.md'],
    ['tab\tand\u0007bell.md', 'tabandbell.md'],
    ['👩\u200D💻.md', '👩\u200D💻.md'], // zero-width joiners in emoji sequences stay
    ['..', 'untitled'],
    ['\u202E', 'untitled'],
  ])('%j → %j', (raw, expected) => {
    expect(sanitizeFilename(raw)).toBe(expected);
  });

  it('limits the length to 255 characters and keeps the extension', () => {
    const name = sanitizeFilename(`${'x'.repeat(400)}.md`);
    expect(Array.from(name)).toHaveLength(255);
    expect(name.endsWith('.md')).toBe(true);
  });

  it('stores bidi and path tricks only as sanitised display names', async () => {
    const { response, store } = await upload({}, [
      { filename: '../../evil\u202Etxt.md', content: '# One' },
      { filename: 'C:\\temp\\two\u200B.txt', content: 'Two' },
    ]);

    expect(response.statusCode).toBe(202);
    const names = response.json<UploadDocumentsResponse>().documents.map((doc) => doc.filename);
    expect(names).toEqual(['eviltxt.md', 'two.txt']);
    expect([...store.documents.values()].map((doc) => doc.filename)).toEqual(names);
  });

  it('judges the type by the sanitised name: a disguised .exe is rejected', async () => {
    const { response } = await upload({}, [
      { filename: 'notes\u202Edm.exe', content: 'MZ', contentType: 'text/markdown' },
    ]);

    expect(response.statusCode).toBe(415);
    expect(response.json<ApiErrorResponse>().error).toMatchObject({
      code: 'UNSUPPORTED_FILE_TYPE',
      details: { filename: 'notesdm.exe' },
    });
  });
});

describe('binary detection', () => {
  it('measures the share of control characters (tab, LF, CR, FF are text)', () => {
    expect(controlCharacterRatio('')).toBe(0);
    expect(controlCharacterRatio('a\tb\nc\r\n\f')).toBe(0);
    expect(controlCharacterRatio('\u0001\u0002ab')).toBe(0.5);
    expect(controlCharacterRatio('\u007F\u0085\u009Fx')).toBe(0.75);
  });

  it('rejects valid UTF-8 without NUL bytes that consists largely of control characters', () => {
    const binaryLike = new Uint8Array(256).map((_, index) => (index % 4 === 0 ? 0x01 : 0x41));
    expect(() => decodeUtf8(binaryLike, 'data.txt')).toThrowError(/binary/);
    // A few stray control characters in a long text are tolerated (normalisation removes them).
    const text = new TextEncoder().encode(`${'Regular text. '.repeat(20)}\u0001\u0002`);
    expect(decodeUtf8(text)).toContain('Regular text.');
  });

  it.each([
    ['NUL bytes', new Uint8Array([0x23, 0x20, 0x41, 0x00, 0x42])],
    ['invalid UTF-8', new Uint8Array([0x23, 0x20, 0xc3, 0x28])],
    ['UTF-16 text', new Uint8Array([0xff, 0xfe, 0x23, 0x00, 0x20, 0x00])],
    ['control characters', new Uint8Array(200).fill(0x02)],
    ['a PNG header', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ])('rejects %s with 400 INVALID_ENCODING and stores nothing', async (_name, bytes) => {
    const { response, store } = await upload({}, [{ filename: 'data.md', content: bytes }]);

    expect(response.statusCode).toBe(400);
    expect(response.json<ApiErrorResponse>().error.code).toBe('INVALID_ENCODING');
    expect(store.documents.size).toBe(0);
  });
});

describe('upload limits', () => {
  it('rejects too many files with 413 TOO_MANY_FILES and stores nothing', async () => {
    const files = [1, 2, 3, 4].map((n) => ({ filename: `${n}.md`, content: `# File ${n}` }));
    const { response, store } = await upload({}, files);

    expect(response.statusCode).toBe(413);
    expect(response.json<ApiErrorResponse>().error.code).toBe('TOO_MANY_FILES');
    expect(store.documents.size).toBe(0);
  });

  it('enforces MAX_DOCUMENTS_PER_COLLECTION (409 DOCUMENT_LIMIT_REACHED)', async () => {
    const started = await startApp({ env: { ...LIMITS, MAX_DOCUMENTS_PER_COLLECTION: '2' } });
    const send = (files: MultipartFilePart[]) => {
      const { payload, headers } = multipart(files);
      return started.api.inject({
        method: 'POST',
        url: `/api/collections/${started.collectionId}/documents`,
        payload,
        headers,
      });
    };

    const tooMany = await send([
      { filename: 'a.md', content: '# A' },
      { filename: 'b.md', content: '# B' },
      { filename: 'c.md', content: '# C' },
    ]);
    expect(tooMany.statusCode).toBe(409);
    expect(tooMany.json<ApiErrorResponse>().error).toMatchObject({
      code: 'DOCUMENT_LIMIT_REACHED',
      details: { maxDocuments: 2, documentCount: 0 },
    });

    expect((await send([{ filename: 'a.md', content: '# A' }])).statusCode).toBe(202);
    expect((await send([{ filename: 'b.md', content: '# B' }])).statusCode).toBe(202);
    const full = await send([{ filename: 'c.md', content: '# C' }]);
    expect(full.statusCode).toBe(409);
    expect(full.json<ApiErrorResponse>().error.details).toMatchObject({ documentCount: 2 });
    expect(started.store.documents.size).toBe(2);
  });

  it('never writes uploads to the file system (content is kept in the database row)', async () => {
    const { response, store } = await upload({}, [{ filename: 'kept.md', content: '# Kept' }]);

    expect(response.statusCode).toBe(202);
    const stored = [...store.documents.values()][0];
    expect(stored?.content).toBe('# Kept');
  });
});
