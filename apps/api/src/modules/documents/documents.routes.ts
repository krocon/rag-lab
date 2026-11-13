import multipart from '@fastify/multipart';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type {
  DocumentContentResponse,
  DocumentDto,
  DocumentListResponse,
  UploadDocumentsResponse,
} from '@raglab/shared';
import type { AppConfig } from '../../config/env.js';
import { DOCUMENT_STATUSES } from '../../db/schema.js';
import { AppError, errorResponseSchema } from '../../http/errors.js';
import { idParamsSchema, type IdParams } from '../../http/schemas.js';
import { SUPPORTED_EXTENSIONS } from '../ingestion/file-type.js';
import { MAX_PATH_LENGTH } from '../ingestion/relative-path.js';
import type { UploadedFile } from '../ingestion/prepare-upload.js';
import type { DocumentsService } from './documents.service.js';

export const documentSchema = {
  type: 'object',
  required: [
    'id',
    'collectionId',
    'filename',
    'path',
    'language',
    'mimeType',
    'sizeBytes',
    'contentSha256',
    'status',
    'errorMessage',
    'chunkCount',
    'metadata',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    collectionId: { type: 'string', format: 'uuid' },
    filename: { type: 'string' },
    path: { type: ['string', 'null'] },
    language: { type: 'string' },
    mimeType: { type: 'string' },
    sizeBytes: { type: 'integer' },
    contentSha256: { type: 'string' },
    status: { type: 'string', enum: [...DOCUMENT_STATUSES] },
    errorMessage: { type: ['string', 'null'] },
    chunkCount: { type: 'integer' },
    metadata: { type: 'object', additionalProperties: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

export interface DocumentsRoutesOptions {
  documents: DocumentsService;
  upload: AppConfig['upload'];
}

/**
 * Form fields other than `path` are ignored, but limited so they cannot be abused to send large
 * bodies. Every file may be preceded by one `path` field, so the field limit grows with the file
 * limit; a path has at most MAX_PATH_LENGTH characters (≤ 4 UTF-8 bytes each).
 */
const MAX_EXTRA_FORM_FIELDS = 10;
const MAX_FORM_FIELD_BYTES = MAX_PATH_LENGTH * 4;

/** Name of the form field that carries the relative path of the **next** file part. */
export const PATH_FIELD_NAME = 'path';

/** Upper bound of `limit` of the document list. */
const MAX_LIST_LIMIT = 1000;

interface DocumentListQuerystring {
  pathPrefix?: string;
  limit?: number;
  offset?: number;
}

/** Documents the multipart body in OpenAPI only; the stream is validated by the handler. */
const uploadBodySchema = {
  type: 'object',
  required: ['file'],
  properties: {
    path: {
      type: 'array',
      items: { type: 'string', maxLength: MAX_PATH_LENGTH },
      description:
        'Optional relative path of the file that follows this field (e.g. `packages/table/src/x.ts`): ' +
        'send a `path` field directly before each file part. Relative, `/` as separator, no `.`/`..` ' +
        `or empty segments, no control/bidi characters, at most ${MAX_PATH_LENGTH} characters; ` +
        'unique per collection (`409 DUPLICATE_PATH`). Display/metadata only.',
    },
    file: {
      type: 'array',
      items: { type: 'string', format: 'binary' },
      description: `One or more files (${SUPPORTED_EXTENSIONS.join(', ')}). The field name is not significant; send each file as its own part.`,
    },
  },
} as const;

function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return Number.isInteger(mib) ? `${mib} MiB` : `${bytes} bytes`;
}

/**
 * Adapts the multipart stream to the service's `UploadedFile` iterable and translates parser
 * errors (limits, malformed bodies) into the API error format.
 */
async function* multipartFiles(
  request: FastifyRequest,
  limits: AppConfig['upload'],
): AsyncGenerator<UploadedFile> {
  const translate = (error: unknown, filename?: string): unknown => {
    if (error instanceof AppError) {
      return error;
    }
    const code = (error as { code?: unknown } | null)?.code;
    switch (code) {
      case 'FST_REQ_FILE_TOO_LARGE':
        return new AppError(
          413,
          'FILE_TOO_LARGE',
          `${filename ? `"${filename}"` : 'A file'} exceeds the maximum file size of ${formatBytes(limits.maxFileBytes)}.`,
          { filename, maxFileBytes: limits.maxFileBytes },
        );
      case 'FST_FILES_LIMIT':
        return new AppError(
          413,
          'TOO_MANY_FILES',
          `Too many files: at most ${limits.maxFiles} files per request.`,
          { maxFiles: limits.maxFiles },
        );
      case 'FST_PARTS_LIMIT':
      case 'FST_FIELDS_LIMIT':
        return new AppError(413, 'PAYLOAD_TOO_LARGE', 'The request has too many form fields.');
      default:
        // Anything else raised while parsing (e.g. missing boundary, truncated body).
        return new AppError(400, 'MALFORMED_MULTIPART', 'The multipart request body is malformed.');
    }
  };

  // All files of a request stay in memory until every file is validated (all or nothing), so
  // their total size is capped as well. The check runs after each file: at most one file
  // (≤ MAX_UPLOAD_BYTES) more than the cap is read.
  let totalBytes = 0;
  /** Value of the last `path` field; applies to the next file part only. */
  let pendingPath: string | undefined;
  const parts = request.parts();
  while (true) {
    let next: Awaited<ReturnType<typeof parts.next>>;
    try {
      next = await parts.next();
    } catch (error) {
      throw translate(error);
    }
    if (next.done) {
      return;
    }
    const part = next.value;
    if (part.type !== 'file') {
      if (part.fieldname === PATH_FIELD_NAME) {
        if (part.valueTruncated || typeof part.value !== 'string') {
          throw new AppError(
            400,
            'INVALID_PATH',
            `A path is invalid: it must not be longer than ${MAX_PATH_LENGTH} characters.`,
            { reason: 'too_long' },
          );
        }
        pendingPath = part.value;
      }
      continue;
    }
    const path = pendingPath;
    pendingPath = undefined;
    let consumed = false;
    yield {
      filename: part.filename,
      path,
      async read() {
        consumed = true;
        let bytes: Buffer;
        try {
          bytes = await part.toBuffer();
        } catch (error) {
          throw translate(error, part.filename);
        }
        totalBytes += bytes.byteLength;
        if (totalBytes > limits.maxRequestBytes) {
          throw new AppError(
            413,
            'UPLOAD_TOO_LARGE',
            `The files of this request exceed ${formatBytes(limits.maxRequestBytes)} in total. Upload them in several requests.`,
            { maxRequestBytes: limits.maxRequestBytes },
          );
        }
        return bytes;
      },
    };
    // The parser only continues once the current file stream has been consumed.
    if (!consumed) {
      part.file.resume();
    }
  }
}

export const documentsRoutes: FastifyPluginAsync<DocumentsRoutesOptions> = async (
  app,
  { documents, upload },
) => {
  // Encapsulated in this plugin: only the document routes accept multipart bodies.
  await app.register(multipart, {
    // Over-long files raise FST_REQ_FILE_TOO_LARGE instead of being silently truncated.
    throwFileSizeLimit: true,
    limits: {
      fileSize: upload.maxFileBytes,
      files: upload.maxFiles,
      fields: upload.maxFiles + MAX_EXTRA_FORM_FIELDS,
      fieldSize: MAX_FORM_FIELD_BYTES,
      parts: 2 * upload.maxFiles + MAX_EXTRA_FORM_FIELDS,
      headerPairs: 100,
    },
  });

  app.post<{ Params: IdParams; Reply: UploadDocumentsResponse }>(
    '/collections/:id/documents',
    {
      schema: {
        tags: ['documents'],
        summary: 'Upload Markdown, text and source code files into a collection',
        description: [
          `\`multipart/form-data\` with one or more files (${SUPPORTED_EXTENSIONS.join(', ')}),`,
          `each at most ${formatBytes(upload.maxFileBytes)}, at most ${upload.maxFiles} files and`,
          `${formatBytes(upload.maxRequestBytes)} in total per request`,
          upload.maxDocumentsPerCollection === null
            ? '(`413 UPLOAD_TOO_LARGE` above the total).'
            : `(\`413 UPLOAD_TOO_LARGE\` above the total), at most ${upload.maxDocumentsPerCollection} documents per collection (\`409 DOCUMENT_LIMIT_REACHED\`).`,
          'Files must be UTF-8 text. They are normalised (BOM, line endings, NFC, control characters,',
          'blank lines) and deduplicated per collection by the SHA-256 of the normalised text.',
          'A `path` form field directly before a file part sets its relative path (validated, unique',
          'per collection: `400 INVALID_PATH`, `409 DUPLICATE_PATH`); the file name is then its last segment.',
          'All files are validated before anything is stored: one invalid file rejects the whole request.',
          'Answers `202 Accepted`; documents start as `pending` and are processed asynchronously.',
        ].join(' '),
        params: idParamsSchema,
        response: {
          202: {
            type: 'object',
            required: ['documents'],
            properties: { documents: { type: 'array', items: documentSchema } },
          },
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          413: errorResponseSchema,
          415: errorResponseSchema,
        },
      },
      config: {
        // The body is streamed, not validated by JSON schema; show it in OpenAPI only.
        swaggerTransform: ({ schema, url }) => ({
          schema: { ...schema, consumes: ['multipart/form-data'], body: uploadBodySchema },
          url,
        }),
      },
    },
    async (request, reply) => {
      if (!request.isMultipart()) {
        throw new AppError(
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          'Expected a multipart/form-data request with one or more files.',
        );
      }
      const uploaded = await documents.upload(request.params.id, multipartFiles(request, upload));
      request.log.info(
        { collectionId: request.params.id, documentIds: uploaded.map((document) => document.id) },
        'documents uploaded',
      );
      return reply.code(202).send({ documents: uploaded });
    },
  );

  app.get<{ Params: IdParams; Querystring: DocumentListQuerystring; Reply: DocumentListResponse }>(
    '/collections/:id/documents',
    {
      schema: {
        tags: ['documents'],
        summary: 'List the documents of a collection (metadata only, without content)',
        description: [
          'Ordered by path (documents without a path last, oldest first).',
          '`pathPrefix` filters by path prefix (literal, case-sensitive); `limit`/`offset` page the',
          'result – without `limit` the complete list is returned. `total` counts all matches.',
        ].join(' '),
        params: idParamsSchema,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pathPrefix: { type: 'string', maxLength: MAX_PATH_LENGTH },
            limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT },
            offset: { type: 'integer', minimum: 0, maximum: 1_000_000 },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['items', 'total'],
            properties: {
              items: { type: 'array', items: documentSchema },
              total: { type: 'integer' },
            },
          },
          400: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request) =>
      documents.listByCollection(request.params.id, {
        pathPrefix: request.query.pathPrefix,
        limit: request.query.limit,
        offset: request.query.offset,
      }),
  );

  app.get<{ Params: IdParams; Reply: DocumentDto }>(
    '/documents/:id',
    {
      schema: {
        tags: ['documents'],
        summary: 'Get document metadata including processing status',
        params: idParamsSchema,
        response: { 200: documentSchema, 400: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request) => documents.get(request.params.id),
  );

  app.get<{ Params: IdParams; Reply: DocumentContentResponse }>(
    '/documents/:id/content',
    {
      schema: {
        tags: ['documents'],
        summary: 'Get the normalised text of a document',
        description: 'The stored text after normalisation; chunk offsets refer to this text.',
        params: idParamsSchema,
        response: {
          200: {
            type: 'object',
            required: ['documentId', 'content'],
            properties: {
              documentId: { type: 'string', format: 'uuid' },
              content: { type: 'string' },
            },
          },
          400: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request) => documents.getContent(request.params.id),
  );

  app.post<{ Params: IdParams; Reply: DocumentDto }>(
    '/documents/:id/reindex',
    {
      schema: {
        tags: ['documents'],
        summary: 'Process a document again (chunking and embedding)',
        description: [
          'Allowed for `failed` documents and for `ready` documents with chunks that have no',
          'embedding yet (e.g. indexed before embeddings existed). Existing chunks are replaced.',
          'Answers `202 Accepted` with the document in status `pending`; processing is asynchronous.',
          '`409 DOCUMENT_BUSY` while the document is `pending` or `processing`,',
          '`409 DOCUMENT_ALREADY_INDEXED` if every chunk already has an embedding.',
        ].join(' '),
        params: idParamsSchema,
        response: {
          202: documentSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const document = await documents.reindex(request.params.id);
      request.log.info({ documentId: document.id }, 'document queued for reindexing');
      return reply.code(202).send(document);
    },
  );

  app.delete<{ Params: IdParams }>(
    '/documents/:id',
    {
      schema: {
        tags: ['documents'],
        summary: 'Delete a document including its chunks',
        params: idParamsSchema,
        response: {
          204: { type: 'null', description: 'Deleted' },
          400: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await documents.delete(request.params.id);
      return reply.code(204).send();
    },
  );
};
