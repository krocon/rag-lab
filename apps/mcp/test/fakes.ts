import type {
  ChatSource,
  ChunkDto,
  CollectionDto,
  DocumentDto,
  RetrievalResult,
  RetrievalSearchResponse,
} from '@raglab/shared';
import type { ChatResult, RaglabClient } from '../src/raglab-client.js';

export const COLLECTION_ID = '0199a000-0000-7000-8000-000000000001';
export const OTHER_COLLECTION_ID = '0199a000-0000-7000-8000-000000000002';
export const DOCUMENT_ID = '0199a000-0000-7000-8000-0000000000d1';
export const CHUNK_ID = '0199a000-0000-7000-8000-0000000000c1';
export const CHUNK_ID_2 = '0199a000-0000-7000-8000-0000000000c2';

export function collection(overrides: Partial<CollectionDto> = {}): CollectionDto {
  return {
    id: COLLECTION_ID,
    name: 'Handbook',
    description: 'Engineering handbook',
    embeddingProvider: 'ollama',
    embeddingModel: 'nomic-embed-text',
    embeddingDimensions: 768,
    documentCount: 2,
    readyDocumentCount: 2,
    chunkCount: 5,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    ...overrides,
  };
}

export const DOCUMENT_TEXT =
  '# Deploy\n\nIntro text before the chunk.\n\n## Rollback\n\nRun `make rollback` to revert.\n\nTrailing text.';

export function document(overrides: Partial<DocumentDto> = {}): DocumentDto {
  return {
    id: DOCUMENT_ID,
    collectionId: COLLECTION_ID,
    filename: 'deploy.md',
    mimeType: 'text/markdown',
    sizeBytes: DOCUMENT_TEXT.length,
    contentSha256: 'a'.repeat(64),
    status: 'ready',
    errorMessage: null,
    chunkCount: 2,
    metadata: { title: 'Deploy' },
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    ...overrides,
  };
}

const rollbackStart = DOCUMENT_TEXT.indexOf('## Rollback');
const rollbackEnd = DOCUMENT_TEXT.indexOf('\n\nTrailing');

export function chunks(): ChunkDto[] {
  const base = {
    documentId: DOCUMENT_ID,
    collectionId: COLLECTION_ID,
    tokenEstimate: 10,
    overlapChars: 0,
    hasEmbedding: true,
    createdAt: '2026-11-01T10:00:00.000Z',
  };
  return [
    {
      ...base,
      id: CHUNK_ID,
      chunkIndex: 0,
      content: DOCUMENT_TEXT.slice(0, rollbackStart),
      startOffset: 0,
      endOffset: rollbackStart,
      charCount: rollbackStart,
      headingPath: ['Deploy'],
    },
    {
      ...base,
      id: CHUNK_ID_2,
      chunkIndex: 1,
      content: DOCUMENT_TEXT.slice(rollbackStart, rollbackEnd),
      startOffset: rollbackStart,
      endOffset: rollbackEnd,
      charCount: rollbackEnd - rollbackStart,
      headingPath: ['Deploy', 'Rollback'],
    },
  ];
}

export function retrievalResult(overrides: Partial<RetrievalResult> = {}): RetrievalResult {
  return {
    rank: 1,
    chunkId: CHUNK_ID_2,
    documentId: DOCUMENT_ID,
    filename: 'deploy.md',
    chunkIndex: 1,
    headingPath: ['Deploy', 'Rollback'],
    content: 'Run `make rollback` to revert.',
    startOffset: 10,
    endOffset: 40,
    distance: 0.25,
    score: 0.75,
    ...overrides,
  };
}

export function searchResponse(
  overrides: Partial<RetrievalSearchResponse> = {},
): RetrievalSearchResponse {
  return {
    collectionId: COLLECTION_ID,
    query: 'how to roll back',
    topK: 8,
    minScore: null,
    embedding: { provider: 'ollama', model: 'nomic-embed-text', dimensions: 768 },
    results: [retrievalResult()],
    timings: { embeddingMs: 1, searchMs: 1 },
    ...overrides,
  };
}

export function chatSource(overrides: Partial<ChatSource> = {}): ChatSource {
  return {
    n: 1,
    documentId: DOCUMENT_ID,
    chunkId: CHUNK_ID_2,
    chunkIndex: 1,
    filename: 'deploy.md',
    headingPath: ['Deploy', 'Rollback'],
    content: 'Run `make rollback` to revert.',
    score: 0.75,
    distance: 0.25,
    ...overrides,
  };
}

export function chatResult(overrides: Partial<ChatResult> = {}): ChatResult {
  return {
    sources: [chatSource()],
    answer: 'Run `make rollback` [1].',
    done: {
      answerStatus: 'answered',
      citedSources: [1],
      unknownCitations: [],
      model: 'llama3.2',
      timings: { embeddingMs: 1, searchMs: 1, firstTokenMs: 1, generationMs: 2, totalMs: 4 },
    },
    error: null,
    ...overrides,
  };
}

/** Fake API client recording its calls; every method can be overridden per test. */
export function fakeClient(overrides: Partial<RaglabClient> = {}): RaglabClient & {
  calls: { method: string; args: unknown[] }[];
} {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    <A extends unknown[], R>(method: string, fn: (...args: A) => Promise<R>) =>
    (...args: A) => {
      calls.push({ method, args: args.filter((arg) => !(arg instanceof AbortSignal)) });
      return fn(...args);
    };
  const defaults: RaglabClient = {
    listCollections: async () => [
      collection(),
      collection({ id: OTHER_COLLECTION_ID, name: 'Notes', description: null }),
    ],
    search: async () => searchResponse(),
    getDocument: async () => document(),
    getDocumentContent: async () => ({ documentId: DOCUMENT_ID, content: DOCUMENT_TEXT }),
    getDocumentChunks: async () => ({ documentId: DOCUMENT_ID, chunks: chunks() }),
    chat: async () => chatResult(),
  };
  const merged = { ...defaults, ...overrides };
  return {
    calls,
    listCollections: record('listCollections', merged.listCollections),
    search: record('search', merged.search),
    getDocument: record('getDocument', merged.getDocument),
    getDocumentContent: record('getDocumentContent', merged.getDocumentContent),
    getDocumentChunks: record('getDocumentChunks', merged.getDocumentChunks),
    chat: record('chat', merged.chat),
  };
}
