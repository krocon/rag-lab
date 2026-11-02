/**
 * Body of every error response of the API: `{ error: { code, message, details? } }`.
 *
 * - `code` is machine-readable (`UPPER_SNAKE_CASE`), e.g. `VALIDATION_ERROR`, `COLLECTION_NOT_FOUND`.
 * - `message` is meant for humans and never contains stack traces or internals.
 * - `details` is optional structured context, e.g. the list of validation issues.
 */
export interface ApiErrorResponse {
  error: ApiError;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

/** One entry of `details` for `400 VALIDATION_ERROR`. */
export interface ValidationIssue {
  /** Where the problem is: `body`, `params`, `querystring` or `headers` plus a JSON pointer. */
  location: string;
  message: string;
}
