import type { DocumentMetadataFields } from '@raglab/shared';
import { AppError, badRequest } from '../../http/errors.js';
import { decodeUtf8 } from './decode.js';
import {
  resolveFileType,
  sanitizeFilename,
  SUPPORTED_EXTENSIONS,
  type DocumentLanguage,
  type DocumentMimeType,
} from './file-type.js';
import { sha256Hex } from './hash.js';
import { extractMetadata } from './metadata.js';
import { isBlank, normalizeText } from './normalize.js';
import { validateRelativePath } from './relative-path.js';

/**
 * One uploaded file as the HTTP layer hands it over. `read()` is called at most once, after the
 * file type has been accepted; it rejects with `413 FILE_TOO_LARGE` if the size limit is exceeded.
 */
export interface UploadedFile {
  readonly filename: string;
  /**
   * Relative path within the imported source (multipart field `path` before the file part);
   * `undefined` for plain uploads. Validated strictly, never used as a file system path.
   */
  readonly path?: string | undefined;
  read(): Promise<Uint8Array>;
}

/** A validated, normalised upload, ready to be stored as a `pending` document. */
export interface PreparedDocument {
  filename: string;
  /** Validated relative path (NFC), `null` for uploads without a path. */
  path: string | null;
  mimeType: DocumentMimeType;
  language: DocumentLanguage;
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
 * path (if any) → type (allowlist by extension) → read bytes → strict UTF-8 → normalise → not blank → hash.
 *
 * Throws `400 INVALID_PATH`, `415 UNSUPPORTED_FILE_TYPE`, `400 INVALID_ENCODING` or `400 EMPTY_DOCUMENT`
 * (plus whatever `file.read()` throws, e.g. `413 FILE_TOO_LARGE`).
 */
export async function prepareUpload(file: UploadedFile): Promise<PreparedDocument> {
  // With a path, the display name is its last segment (the multipart file name is ignored).
  const path =
    file.path === undefined
      ? null
      : validateRelativePath(file.path, sanitizeFilename(file.filename));
  const filename = sanitizeFilename(path ?? file.filename);
  const fileType = resolveFileType(filename);
  if (fileType === undefined) {
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

  const { mimeType, language } = fileType;
  return {
    filename,
    path,
    mimeType,
    language,
    sizeBytes: bytes.byteLength,
    content,
    contentSha256: sha256Hex(content),
    metadata: extractMetadata(content, mimeType),
  };
}
