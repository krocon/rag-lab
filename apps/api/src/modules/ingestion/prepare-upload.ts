import type { DocumentMetadataFields } from '@raglab/shared';
import { AppError, badRequest } from '../../http/errors.js';
import { decodeUtf8 } from './decode.js';
import {
  resolveMimeType,
  sanitizeFilename,
  SUPPORTED_EXTENSIONS,
  type DocumentMimeType,
} from './file-type.js';
import { sha256Hex } from './hash.js';
import { extractMetadata } from './metadata.js';
import { isBlank, normalizeText } from './normalize.js';

/**
 * One uploaded file as the HTTP layer hands it over. `read()` is called at most once, after the
 * file type has been accepted; it rejects with `413 FILE_TOO_LARGE` if the size limit is exceeded.
 */
export interface UploadedFile {
  readonly filename: string;
  read(): Promise<Uint8Array>;
}

/** A validated, normalised upload, ready to be stored as a `pending` document. */
export interface PreparedDocument {
  filename: string;
  mimeType: DocumentMimeType;
  /** Size of the original file in bytes. */
  sizeBytes: number;
  /** Normalised text. */
  content: string;
  /** SHA-256 (hex) of the normalised text. */
  contentSha256: string;
  metadata: DocumentMetadataFields;
}

/**
 * Validates and normalises one uploaded file:
 * type (allowlist by extension) → read bytes → strict UTF-8 → normalise → not blank → hash.
 *
 * Throws `415 UNSUPPORTED_FILE_TYPE`, `400 INVALID_ENCODING` or `400 EMPTY_DOCUMENT`
 * (plus whatever `file.read()` throws, e.g. `413 FILE_TOO_LARGE`).
 */
export async function prepareUpload(file: UploadedFile): Promise<PreparedDocument> {
  const filename = sanitizeFilename(file.filename);
  const mimeType = resolveMimeType(filename);
  if (mimeType === undefined) {
    throw new AppError(
      415,
      'UNSUPPORTED_FILE_TYPE',
      `"${filename}" is not supported. Allowed file types: ${SUPPORTED_EXTENSIONS.join(', ')}.`,
      { filename, allowedExtensions: SUPPORTED_EXTENSIONS },
    );
  }

  const bytes = await file.read();
  const content = normalizeText(decodeUtf8(bytes, filename));
  if (isBlank(content)) {
    throw badRequest('EMPTY_DOCUMENT', `"${filename}" is empty or contains only whitespace.`, {
      filename,
    });
  }

  return {
    filename,
    mimeType,
    sizeBytes: bytes.byteLength,
    content,
    contentSha256: sha256Hex(content),
    metadata: extractMetadata(content, mimeType),
  };
}
