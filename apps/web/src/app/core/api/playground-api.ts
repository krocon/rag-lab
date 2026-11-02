import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { PlaygroundSearchRequest, PlaygroundSearchResponse } from '@raglab/shared';
import { type Observable, catchError, throwError } from 'rxjs';
import { toApiRequestError } from './api-error';
import { API_PATHS } from './api-paths';

/**
 * Client for `POST /api/playground/search` (retrieval diagnostics). Errors are mapped to
 * `ApiRequestError` (`400`, `404`, `409 EMBEDDING_MODEL_MISMATCH`, `502`/`503` provider errors,
 * `0`/`NETWORK_ERROR`). Unsubscribing cancels the request.
 */
@Injectable({ providedIn: 'root' })
export class PlaygroundApi {
  private readonly http = inject(HttpClient);

  search(request: PlaygroundSearchRequest): Observable<PlaygroundSearchResponse> {
    return this.http
      .post<PlaygroundSearchResponse>(API_PATHS.playgroundSearch, request)
      .pipe(catchError((error: unknown) => throwError(() => toApiRequestError(error))));
  }
}
