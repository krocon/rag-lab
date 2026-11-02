import type {
  ChatDoneEvent,
  ChatSource,
  ChunkDto,
  CollectionDto,
  DocumentDto,
  PlaygroundResult,
  PlaygroundSearchResponse,
  ProvidersStatusResponse,
  SystemInfoResponse,
} from '@raglab/shared';

export const COLLECTION_ID = '0190a8c4-0000-7000-8000-000000000001';
export const DOCUMENT_ID = '0190a8c4-0000-7000-8000-000000000002';

export function collection(overrides: Partial<CollectionDto> = {}): CollectionDto {
  return {
    id: COLLECTION_ID,
    name: 'Project docs',
    description: 'Architecture notes',
    embeddingProvider: 'ollama',
    embeddingModel: 'example-embed',
    embeddingDimensions: 768,
    documentCount: 2,
    readyDocumentCount: 1,
    chunkCount: 12,
    createdAt: '2026-11-02T08:00:00.000Z',
    updatedAt: '2026-11-02T08:00:00.000Z',
    ...overrides,
  };
}

export function document(overrides: Partial<DocumentDto> = {}): DocumentDto {
  return {
    id: DOCUMENT_ID,
    collectionId: COLLECTION_ID,
    filename: 'notes.md',
    mimeType: 'text/markdown',
    sizeBytes: 2048,
    contentSha256: 'a'.repeat(64),
    status: 'ready',
    errorMessage: null,
    chunkCount: 3,
    metadata: {},
    createdAt: '2026-11-02T08:00:00.000Z',
    updatedAt: '2026-11-02T08:00:00.000Z',
    ...overrides,
  };
}

export function chunk(index: number, overrides: Partial<ChunkDto> = {}): ChunkDto {
  return {
    id: `0190a8c4-0000-7000-8000-00000000010${index}`,
    documentId: DOCUMENT_ID,
    collectionId: COLLECTION_ID,
    chunkIndex: index,
    content: `Chunk content ${index}`,
    startOffset: index * 100,
    endOffset: index * 100 + 15,
    charCount: 15,
    tokenEstimate: 4,
    headingPath: ['Guide', 'Setup'],
    overlapChars: 0,
    hasEmbedding: true,
    createdAt: '2026-11-02T08:00:00.000Z',
    ...overrides,
  };
}

export const systemInfo: SystemInfoResponse = {
  version: '0.1.0',
  nodeVersion: 'v24.21.0',
  embedding: { provider: 'ollama', model: 'example-embed', dimensions: 768 },
  chat: { provider: 'ollama', model: 'example-chat' },
  retrieval: { defaultTopK: 8, maxQueryChars: 2000 },
  chunking: { targetSize: 1200, overlap: 200 },
  upload: { maxFileBytes: 1024, maxFiles: 20, allowedExtensions: ['.md', '.markdown', '.txt'] },
};

export const providersOk: ProvidersStatusResponse = {
  embedding: {
    provider: 'ollama',
    model: 'example-embed',
    reachable: true,
    modelAvailable: true,
    dimensions: { configured: 768, column: 768 },
    verification: { status: 'skipped' },
  },
  chat: { provider: 'ollama', model: 'example-chat', reachable: true, modelAvailable: true },
  checkedAt: '2026-11-02T08:00:00.000Z',
};

export function apiError(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

export function text(element: Element | null | undefined): string {
  return element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

/** Returns the value or fails the test – a typed alternative to non-null assertions. */
export function required<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${what} to exist`);
  }
  return value;
}

export function chatSource(n: number, overrides: Partial<ChatSource> = {}): ChatSource {
  return {
    n,
    documentId: DOCUMENT_ID,
    chunkId: `0190a8c4-0000-7000-8000-00000000020${n}`,
    chunkIndex: n - 1,
    filename: `guide-${n}.md`,
    headingPath: ['Guide', `Part ${n}`],
    content: `Passage ${n} about reindexing.`,
    score: 0.9 - n / 10,
    distance: 0.1 + n / 10,
    ...overrides,
  };
}

export function chatDone(overrides: Partial<ChatDoneEvent> = {}): ChatDoneEvent {
  return {
    answerStatus: 'answered',
    citedSources: [1],
    unknownCitations: [],
    model: 'example-chat',
    timings: { embeddingMs: 5, searchMs: 2, firstTokenMs: 100, generationMs: 900, totalMs: 1234 },
    ...overrides,
  };
}

export function playgroundResult(
  rank: number,
  overrides: Partial<PlaygroundResult> = {},
): PlaygroundResult {
  const score = 0.95 - rank / 10;
  return {
    rank,
    chunkId: `0190a8c4-0000-7000-8000-00000000030${rank}`,
    documentId: DOCUMENT_ID,
    filename: `guide-${rank}.md`,
    chunkIndex: rank - 1,
    headingPath: ['Guide', `Part ${rank}`],
    content: `Passage ${rank} about reindexing.`,
    startOffset: rank * 100,
    endOffset: rank * 100 + 31,
    distance: 1 - score,
    score,
    includedInChatContext: true,
    belowMinScore: false,
    ...overrides,
  };
}

export function playgroundResponse(
  overrides: Partial<PlaygroundSearchResponse> = {},
): PlaygroundSearchResponse {
  return {
    collectionId: COLLECTION_ID,
    query: 'How do I reindex?',
    results: [
      playgroundResult(1),
      playgroundResult(2),
      playgroundResult(3, { includedInChatContext: false }),
      playgroundResult(4, { includedInChatContext: false, belowMinScore: true }),
    ],
    stats: {
      documentCount: 2,
      documentsByStatus: { pending: 0, processing: 0, ready: 2, failed: 0 },
      chunkCount: 12,
      searchableChunkCount: 12,
      chunksWithoutEmbedding: 0,
    },
    embedding: {
      collection: { provider: 'ollama', model: 'example-embed', dimensions: 768 },
      provider: { provider: 'ollama', model: 'example-embed', dimensions: 768 },
      matches: true,
    },
    search: {
      metric: 'cosine',
      operator: '<=>',
      iterativeScan: 'relaxed_order',
      efSearch: 40,
      topK: 4,
      minScore: 0.6,
    },
    chatContext: {
      charBudget: 12000,
      usedChars: 420,
      includedCount: 2,
      omittedByBudgetCount: 1,
      belowMinScoreCount: 1,
    },
    warnings: [],
    timings: { embeddingMs: 12.3, searchMs: 4.5 },
    ...overrides,
  };
}
