/** Builds `multipart/form-data` payloads for `app.inject()` with full control over the bytes. */

export interface MultipartFilePart {
  filename: string;
  content: string | Uint8Array;
  /** Client-declared type; the API ignores it and derives the type from the extension. */
  contentType?: string;
  field?: string;
}

export interface MultipartFieldPart {
  field: string;
  value: string;
}

const BOUNDARY = '----raglab-test-boundary-7MA4YWxkTrZu0gW';

export function multipart(parts: (MultipartFilePart | MultipartFieldPart)[]): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n`));
    if ('filename' in part) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.field ?? 'file'}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`,
        ),
      );
      chunks.push(
        typeof part.content === 'string' ? Buffer.from(part.content) : Buffer.from(part.content),
      );
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.field}"\r\n\r\n`));
      chunks.push(Buffer.from(part.value));
    }
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  };
}
