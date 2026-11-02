import { HttpClient, type HttpEvent } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type {
  CollectionDto,
  CollectionListResponse,
  CreateCollectionRequest,
  DocumentChunksResponse,
  DocumentContentResponse,
  DocumentDto,
  DocumentListResponse,
  ProvidersStatusResponse,
  SystemInfoResponse,
  UpdateCollectionRequest,
  UploadDocumentsResponse,
} from '@raglab/shared';
import { type Observable, catchError, map, throwError } from 'rxjs';
import { toApiRequestError } from './api-error';
import { API_PATHS } from './api-paths';

/**
 * Typed client for the knowledge-base endpoints (collections, documents, chunks, upload).
 * Every error is mapped to an `ApiRequestError`, so callers never deal with `HttpErrorResponse`.
 * Methods return cold observables: use them with `rxResource` for reads and `firstValueFrom`
 * (or `subscribe`) for actions.
 */
@Injectable({ providedIn: 'root' })
export class KnowledgeApi {
  private readonly http = inject(HttpClient);

  getSystemInfo(): Observable<SystemInfoResponse> {
    return this.handle(this.http.get<SystemInfoResponse>(API_PATHS.systemInfo));
  }

  getProviders(): Observable<ProvidersStatusResponse> {
    return this.handle(this.http.get<ProvidersStatusResponse>(API_PATHS.systemProviders));
  }

  listCollections(): Observable<CollectionDto[]> {
    return this.handle(
      this.http.get<CollectionListResponse>(API_PATHS.collections).pipe(map((r) => r.items)),
    );
  }

  getCollection(id: string): Observable<CollectionDto> {
    return this.handle(this.http.get<CollectionDto>(API_PATHS.collection(id)));
  }

  createCollection(body: CreateCollectionRequest): Observable<CollectionDto> {
    return this.handle(this.http.post<CollectionDto>(API_PATHS.collections, body));
  }

  updateCollection(id: string, body: UpdateCollectionRequest): Observable<CollectionDto> {
    return this.handle(this.http.patch<CollectionDto>(API_PATHS.collection(id), body));
  }

  deleteCollection(id: string): Observable<void> {
    return this.handle(this.http.delete(API_PATHS.collection(id)).pipe(map(() => undefined)));
  }

  listDocuments(collectionId: string): Observable<DocumentDto[]> {
    return this.handle(
      this.http
        .get<DocumentListResponse>(API_PATHS.collectionDocuments(collectionId))
        .pipe(map((r) => r.items)),
    );
  }

  getDocument(id: string): Observable<DocumentDto> {
    return this.handle(this.http.get<DocumentDto>(API_PATHS.document(id)));
  }

  getDocumentContent(id: string): Observable<DocumentContentResponse> {
    return this.handle(this.http.get<DocumentContentResponse>(API_PATHS.documentContent(id)));
  }

  getDocumentChunks(id: string): Observable<DocumentChunksResponse> {
    return this.handle(this.http.get<DocumentChunksResponse>(API_PATHS.documentChunks(id)));
  }

  reindexDocument(id: string): Observable<DocumentDto> {
    return this.handle(this.http.post<DocumentDto>(API_PATHS.documentReindex(id), null));
  }

  deleteDocument(id: string): Observable<void> {
    return this.handle(this.http.delete(API_PATHS.document(id)).pipe(map(() => undefined)));
  }

  /**
   * Uploads files as `multipart/form-data` and reports upload progress
   * (`HttpEventType.UploadProgress`) followed by the `202` response.
   */
  uploadDocuments(
    collectionId: string,
    files: readonly File[],
  ): Observable<HttpEvent<UploadDocumentsResponse>> {
    const body = new FormData();
    for (const file of files) {
      body.append('file', file, file.name);
    }
    return this.handle(
      this.http.post<UploadDocumentsResponse>(API_PATHS.collectionDocuments(collectionId), body, {
        observe: 'events',
        reportUploadProgress: true,
      }),
    );
  }

  private handle<T>(source: Observable<T>): Observable<T> {
    return source.pipe(catchError((error: unknown) => throwError(() => toApiRequestError(error))));
  }
}
