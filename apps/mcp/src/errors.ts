/**
 * Error of a RAGLab API call. `code` is the API's error code (`COLLECTION_NOT_FOUND`,
 * `VALIDATION_ERROR`, `RATE_LIMITED`, …) or one of the client-side codes below; `status` is the
 * HTTP status (`0` when no response was received).
 */
export class RaglabApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'RaglabApiError';
  }
}

/** Client-side error codes (no API response to take the code from). */
export const CLIENT_ERROR_CODES = {
  unreachable: 'API_UNREACHABLE',
  timeout: 'API_TIMEOUT',
  unexpectedResponse: 'UNEXPECTED_RESPONSE',
  streamInterrupted: 'STREAM_INTERRUPTED',
} as const;

/**
 * Error of a tool that is not an API error, e.g. an unknown collection name or chunk id.
 * Its message is shown to the MCP client as is.
 */
export class ToolInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolInputError';
  }
}
