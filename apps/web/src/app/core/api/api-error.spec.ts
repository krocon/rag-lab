import { HttpErrorResponse } from '@angular/common/http';
import {
  ApiRequestError,
  GENERIC_ERROR_MESSAGE,
  NETWORK_ERROR_MESSAGE,
  isApiErrorResponse,
  toApiRequestError,
} from './api-error';

describe('toApiRequestError', () => {
  it('maps the API error format with status, code, message and details', () => {
    const error = toApiRequestError(
      new HttpErrorResponse({
        status: 409,
        error: {
          error: {
            code: 'DUPLICATE_DOCUMENT',
            message: 'Same content',
            details: { existingDocumentId: 'abc', filename: 'a.md' },
          },
        },
      }),
    );

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(409);
    expect(error.code).toBe('DUPLICATE_DOCUMENT');
    expect(error.message).toBe('Same content');
    expect(error.detail('existingDocumentId')).toBe('abc');
    expect(error.detail('missing')).toBeUndefined();
  });

  it('exposes validation issues of a 400 VALIDATION_ERROR', () => {
    const error = toApiRequestError(
      new HttpErrorResponse({
        status: 400,
        error: {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid body',
            details: [
              { location: 'body/name', message: 'must NOT have fewer than 1 characters' },
              42,
            ],
          },
        },
      }),
    );

    expect(error.validationIssues).toEqual([
      { location: 'body/name', message: 'must NOT have fewer than 1 characters' },
    ]);
  });

  it('reports an unreachable API (status 0) with a hint', () => {
    const error = toApiRequestError(
      new HttpErrorResponse({ status: 0, error: new ProgressEvent('error') }),
    );

    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.message).toBe(NETWORK_ERROR_MESSAGE);
  });

  it('uses a generic message for unknown bodies and non-HTTP errors', () => {
    const fromHtml = toApiRequestError(
      new HttpErrorResponse({ status: 502, error: '<html>Bad gateway</html>' }),
    );
    expect(fromHtml.status).toBe(502);
    expect(fromHtml.code).toBe('UNKNOWN_ERROR');
    expect(fromHtml.message).toBe(GENERIC_ERROR_MESSAGE);

    expect(toApiRequestError(new TypeError('boom')).message).toBe(GENERIC_ERROR_MESSAGE);
  });

  it('explains a 413 without API body (e.g. from a reverse proxy)', () => {
    const error = toApiRequestError(
      new HttpErrorResponse({ status: 413, error: '<html>413 Request Entity Too Large</html>' }),
    );
    expect(error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(error.message).toBe('The request is too large for the server.');
  });

  it('returns ApiRequestError instances unchanged', () => {
    const error = new ApiRequestError(404, 'COLLECTION_NOT_FOUND', 'Not found');
    expect(toApiRequestError(error)).toBe(error);
  });
});

describe('isApiErrorResponse', () => {
  it('accepts only bodies with error.code and error.message strings', () => {
    expect(isApiErrorResponse({ error: { code: 'X', message: 'y' } })).toBe(true);
    expect(isApiErrorResponse({ error: { code: 'X' } })).toBe(false);
    expect(isApiErrorResponse({ error: 'X' })).toBe(false);
    expect(isApiErrorResponse(null)).toBe(false);
  });
});
