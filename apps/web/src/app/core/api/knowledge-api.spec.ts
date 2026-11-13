import { HttpEventType, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, toArray } from 'rxjs';
import {
  COLLECTION_ID,
  DOCUMENT_ID,
  apiError,
  collection,
  document,
} from '../../../testing/fixtures';
import { ApiRequestError } from './api-error';
import { KnowledgeApi } from './knowledge-api';

describe('KnowledgeApi', () => {
  let api: KnowledgeApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(KnowledgeApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('lists collections and unwraps items', async () => {
    const result = firstValueFrom(api.listCollections());
    http.expectOne({ method: 'GET', url: '/api/collections' }).flush({ items: [collection()] });
    expect(await result).toEqual([collection()]);
  });

  it('creates, updates and deletes collections', async () => {
    const created = firstValueFrom(api.createCollection({ name: 'Docs' }));
    const create = http.expectOne({ method: 'POST', url: '/api/collections' });
    expect(create.request.body).toEqual({ name: 'Docs' });
    create.flush(collection(), { status: 201, statusText: 'Created' });
    expect((await created).id).toBe(COLLECTION_ID);

    const updated = firstValueFrom(api.updateCollection(COLLECTION_ID, { description: null }));
    const patch = http.expectOne({ method: 'PATCH', url: `/api/collections/${COLLECTION_ID}` });
    expect(patch.request.body).toEqual({ description: null });
    patch.flush(collection({ description: null }));
    expect((await updated).description).toBeNull();

    const deleted = firstValueFrom(api.deleteCollection(COLLECTION_ID));
    http
      .expectOne({ method: 'DELETE', url: `/api/collections/${COLLECTION_ID}` })
      .flush(null, { status: 204, statusText: 'No Content' });
    expect(await deleted).toBeUndefined();
  });

  it('reads documents, content and chunks', async () => {
    const list = firstValueFrom(api.listDocuments(COLLECTION_ID));
    http.expectOne(`/api/collections/${COLLECTION_ID}/documents`).flush({ items: [document()] });
    expect(await list).toHaveLength(1);

    const content = firstValueFrom(api.getDocumentContent(DOCUMENT_ID));
    http
      .expectOne(`/api/documents/${DOCUMENT_ID}/content`)
      .flush({ documentId: DOCUMENT_ID, content: 'x' });
    expect((await content).content).toBe('x');

    const chunks = firstValueFrom(api.getDocumentChunks(DOCUMENT_ID));
    http
      .expectOne(`/api/documents/${DOCUMENT_ID}/chunks`)
      .flush({ documentId: DOCUMENT_ID, chunks: [] });
    expect((await chunks).chunks).toEqual([]);

    const reindex = firstValueFrom(api.reindexDocument(DOCUMENT_ID));
    http
      .expectOne({ method: 'POST', url: `/api/documents/${DOCUMENT_ID}/reindex` })
      .flush(document({ status: 'pending' }), { status: 202, statusText: 'Accepted' });
    expect((await reindex).status).toBe('pending');
  });

  it('requests a filtered page of documents with query parameters', async () => {
    const page = firstValueFrom(
      api.listDocumentPage(COLLECTION_ID, { pathPrefix: 'packages/a b', limit: 100, offset: 200 }),
    );
    const request = http.expectOne(
      (req) => req.method === 'GET' && req.url === `/api/collections/${COLLECTION_ID}/documents`,
    );
    expect(request.request.params.get('pathPrefix')).toBe('packages/a b');
    expect(request.request.params.get('limit')).toBe('100');
    expect(request.request.params.get('offset')).toBe('200');
    request.flush({ items: [document()], total: 201 });
    expect(await page).toEqual({ items: [document()], total: 201 });

    const unfiltered = firstValueFrom(
      api.listDocumentPage(COLLECTION_ID, { pathPrefix: '', limit: 10, offset: 0 }),
    );
    const second = http.expectOne(`/api/collections/${COLLECTION_ID}/documents?limit=10&offset=0`);
    expect(second.request.params.has('pathPrefix')).toBe(false);
    second.flush({ items: [], total: 0 });
    await unfiltered;
  });

  it('encodes ids in URLs', async () => {
    const result = firstValueFrom(api.getDocument('a/b'));
    http.expectOne('/api/documents/a%2Fb').flush(document());
    await result;
  });

  it('uploads files as multipart form data and reports upload progress', async () => {
    const file = new File(['# Hi'], 'hi.md', { type: 'text/markdown' });
    const events = firstValueFrom(api.uploadDocuments(COLLECTION_ID, [file]).pipe(toArray()));

    const request = http.expectOne({
      method: 'POST',
      url: `/api/collections/${COLLECTION_ID}/documents`,
    });
    expect(request.request.reportUploadProgress).toBe(true);
    const body = request.request.body as FormData;
    expect((body.getAll('file')[0] as File).name).toBe('hi.md');

    request.event({ type: HttpEventType.UploadProgress, loaded: 2, total: 4 });
    request.flush(
      { documents: [document({ status: 'pending' })] },
      { status: 202, statusText: 'Accepted' },
    );

    const types = (await events).map((event) => event.type);
    expect(types).toContain(HttpEventType.UploadProgress);
    expect(types).toContain(HttpEventType.Response);
  });

  it('maps HTTP errors to ApiRequestError', async () => {
    const result = firstValueFrom(api.getCollection(COLLECTION_ID));
    http
      .expectOne(`/api/collections/${COLLECTION_ID}`)
      .flush(apiError('COLLECTION_NOT_FOUND', 'Collection does not exist'), {
        status: 404,
        statusText: 'Not Found',
      });

    const error = await result.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 404, code: 'COLLECTION_NOT_FOUND' });
  });
});
