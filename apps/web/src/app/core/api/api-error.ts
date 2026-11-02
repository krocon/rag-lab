import { HttpErrorResponse } from '@angular/common/http';
import type { ApiErrorResponse, ValidationIssue } from '@raglab/shared';

/** Message for failures without a usable API error body (network errors, proxies, crashes). */
export const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.';
export const PAYLOAD_TOO_LARGE_MESSAGE = 'The request is too large for the server.';
export const NETWORK_ERROR_MESSAGE = 'The API is not reachable. Is it running (pnpm dev:api)?';

/**
 * A failed API request in the API's error format (`{ error: { code, message, details? } }`).
 * Extends `Error` so resources (`rxResource`) keep it as is instead of wrapping it.
 */
export class ApiRequestError extends Error {
  constructor(
    /** HTTP status; 0 when the API could not be reached. */
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** Validation issues of a `400 VALIDATION_ERROR`, if present. */
  get validationIssues(): ValidationIssue[] {
    return Array.isArray(this.details) ? this.details.filter(isValidationIssue) : [];
  }

  /** A string field of `details`, e.g. `existingDocumentId` of `409 DUPLICATE_DOCUMENT`. */
  detail(key: string): string | undefined {
    if (typeof this.details !== 'object' || this.details === null) {
      return undefined;
    }
    const value = (this.details as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
  }
}

/** Maps anything thrown by `HttpClient` (or elsewhere) to an {@link ApiRequestError}. */
export function toApiRequestError(error: unknown): ApiRequestError {
  if (error instanceof ApiRequestError) {
    return error;
  }
  if (error instanceof HttpErrorResponse) {
    if (isApiErrorResponse(error.error)) {
      const { code, message, details } = error.error.error;
      return new ApiRequestError(error.status, code, message, details);
    }
    if (error.status === 0) {
      return new ApiRequestError(0, 'NETWORK_ERROR', NETWORK_ERROR_MESSAGE);
    }
    if (error.status === 413) {
      // E.g. from a reverse proxy in front of the API, without the API's error body.
      return new ApiRequestError(413, 'PAYLOAD_TOO_LARGE', PAYLOAD_TOO_LARGE_MESSAGE);
    }
    return new ApiRequestError(error.status, 'UNKNOWN_ERROR', GENERIC_ERROR_MESSAGE);
  }
  return new ApiRequestError(0, 'UNKNOWN_ERROR', GENERIC_ERROR_MESSAGE);
}

export function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  if (typeof value !== 'object' || value === null || !('error' in value)) {
    return false;
  }
  const error = (value as { error: unknown }).error;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

function isValidationIssue(value: unknown): value is ValidationIssue {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { location?: unknown }).location === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}
