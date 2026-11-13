import { describe, expect, it } from 'vitest';
import type { ChunkDraft } from '../../src/modules/chunking/chunker.js';
import {
  CHUNKING_STEP_NAME,
  createChunkingStep,
  NO_CHUNKS_MESSAGE,
} from '../../src/modules/chunking/chunking.step.js';
import type { IndexingContext } from '../../src/modules/ingestion/document-indexer.js';
import { IndexingError } from '../../src/modules/ingestion/document-indexer.js';

function context(content: string, mimeType = 'text/markdown'): IndexingContext {
  return {
    document: { id: 'doc-1', collectionId: 'col-1', filename: 'a.md', path: null, mimeType, content },
    chunkCount: 0,
  };
}

function recordingRepository() {
  const calls: { document: { id: string; collectionId: string }; drafts: readonly ChunkDraft[] }[] =
    [];
  return {
    calls,
    replaceForDocument: async (
      document: { id: string; collectionId: string },
      drafts: readonly ChunkDraft[],
    ) => {
      calls.push({ document, drafts });
    },
  };
}

describe('chunking step', () => {
  it('chunks the content with the configured options and stores the chunks', async () => {
    const repository = recordingRepository();
    const step = createChunkingStep({ repository, options: { targetSize: 20, overlap: 0 } });
    const ctx = context('# Title\n\nFirst paragraph.\n\nSecond paragraph.');

    await step.run(ctx, new AbortController().signal);

    expect(step.name).toBe(CHUNKING_STEP_NAME);
    expect(repository.calls).toHaveLength(1);
    const [call] = repository.calls;
    expect(call?.document).toMatchObject({ id: 'doc-1', collectionId: 'col-1' });
    expect(call?.drafts.map((draft) => draft.content)).toEqual([
      '# Title',
      'First paragraph.',
      'Second paragraph.',
    ]);
    expect(call?.drafts.every((draft) => draft.headingPath[0] === 'Title')).toBe(true);
    expect(ctx.chunkCount).toBe(3);
  });

  it('chunks source code by declarations; the heading path is file path and symbol', async () => {
    const repository = recordingRepository();
    const step = createChunkingStep({ repository, options: { targetSize: 40, overlap: 0 } });
    const ctx: IndexingContext = {
      document: {
        id: 'doc-1',
        collectionId: 'col-1',
        filename: 'tree.ts',
        path: 'packages/table/src/tree.ts',
        mimeType: 'text/typescript',
        content: 'export class Tree {\n  a = 1;\n}\n\nexport function build() {\n  return 1;\n}\n',
      },
      chunkCount: 0,
    };

    await step.run(ctx, new AbortController().signal);

    const drafts = repository.calls[0]?.drafts ?? [];
    expect(drafts.map((draft) => draft.headingPath)).toEqual([
      ['packages/table/src/tree.ts', 'class Tree'],
      ['packages/table/src/tree.ts', 'function build'],
    ]);
    expect(drafts.map((draft) => [draft.startLine, draft.endLine])).toEqual([
      [1, 3],
      [5, 7],
    ]);
  });

  it('chunks plain text without heading sections', async () => {
    const repository = recordingRepository();
    const step = createChunkingStep({ repository, options: { targetSize: 100, overlap: 10 } });

    await step.run(context('# no heading\ntext', 'text/plain'), new AbortController().signal);

    expect(repository.calls[0]?.drafts[0]?.headingPath).toEqual([]);
  });

  it('fails with a user-facing message when there is nothing to chunk', async () => {
    const repository = recordingRepository();
    const step = createChunkingStep({ repository, options: { targetSize: 100, overlap: 10 } });

    const run = step.run(context(' \n\n '), new AbortController().signal);

    await expect(run).rejects.toThrow(IndexingError);
    await expect(run).rejects.toThrow(NO_CHUNKS_MESSAGE);
    expect(repository.calls).toHaveLength(0);
  });

  it('stores nothing when aborted before writing', async () => {
    const repository = recordingRepository();
    const step = createChunkingStep({ repository, options: { targetSize: 100, overlap: 10 } });
    const controller = new AbortController();
    controller.abort();

    await expect(step.run(context('text'), controller.signal)).rejects.toThrow();
    expect(repository.calls).toHaveLength(0);
  });
});
