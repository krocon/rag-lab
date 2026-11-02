import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CollectionDto } from '@raglab/shared';
import { z } from 'zod';
import { truncate } from '../format.js';
import { READ_ONLY, runTool, success, type ToolContext } from './context.js';

export const LIST_COLLECTIONS = 'list_collections';

const collectionShape = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  documentCount: z.number().int(),
  readyDocumentCount: z.number().int(),
  chunkCount: z.number().int(),
  embeddingProvider: z.string(),
  embeddingModel: z.string(),
  embeddingDimensions: z.number().int(),
});

export const listCollectionsOutput = {
  collections: z.array(collectionShape),
  /** True when collections were left out to respect MCP_MAX_OUTPUT_CHARS. */
  truncated: z.boolean(),
};

/** Descriptions can hold up to 2 000 characters; the list only needs a summary. */
const MAX_DESCRIPTION_CHARS = 300;

export function registerListCollections(server: McpServer, context: ToolContext): void {
  server.registerTool(
    LIST_COLLECTIONS,
    {
      title: 'List RAGLab collections',
      description: [
        'Lists all knowledge bases (collections) of the RAGLab instance with ID, name, description,',
        'document and chunk counts and the embedding model. Call this first to find the collection',
        'to pass to search_knowledge or ask_knowledge (they accept the ID or the exact name).',
        'Only documents with status "ready" (readyDocumentCount) are searchable.',
      ].join(' '),
      outputSchema: listCollectionsOutput,
      annotations: { ...READ_ONLY, idempotentHint: true },
    },
    async ({ signal }) =>
      runTool(LIST_COLLECTIONS, context, signal, async () => {
        const all = (await context.client.listCollections(signal)).map(toOutput);
        // Keep the structured list within the output limit as well (whole entries only).
        const collections: typeof all = [];
        let size = 0;
        for (const collection of all) {
          size += JSON.stringify(collection).length + 1;
          if (size > context.config.maxOutputChars) {
            break;
          }
          collections.push(collection);
        }
        const truncated = collections.length < all.length;
        let text = formatCollections(collections);
        if (truncated) {
          text += `\n[${all.length - collections.length} more collection(s) not shown: MCP_MAX_OUTPUT_CHARS reached]`;
        }
        return success(context, text, { collections, truncated });
      }),
  );
}

function toOutput(collection: CollectionDto): z.infer<typeof collectionShape> {
  return {
    id: collection.id,
    name: collection.name,
    description: collection.description === null ? null : shorten(collection.description),
    documentCount: collection.documentCount,
    readyDocumentCount: collection.readyDocumentCount,
    chunkCount: collection.chunkCount,
    embeddingProvider: collection.embeddingProvider,
    embeddingModel: collection.embeddingModel,
    embeddingDimensions: collection.embeddingDimensions,
  };
}

function shorten(description: string): string {
  const result = truncate(description, MAX_DESCRIPTION_CHARS);
  return result.truncated ? `${result.text}…` : result.text;
}

function formatCollections(collections: z.infer<typeof collectionShape>[]): string {
  if (collections.length === 0) {
    return 'There are no collections yet. Create one and upload documents in the RAGLab web app.';
  }
  const lines = [`${collections.length} collection(s):`, ''];
  for (const collection of collections) {
    lines.push(
      `- ${JSON.stringify(collection.name)} (id: ${collection.id})`,
      `  documents: ${collection.documentCount} (${collection.readyDocumentCount} ready), ` +
        `chunks: ${collection.chunkCount}, embedding: ${collection.embeddingProvider}/` +
        `${collection.embeddingModel} (${collection.embeddingDimensions} dims)`,
    );
    if (collection.description) {
      lines.push(`  description: ${collection.description.replace(/\s+/g, ' ')}`);
    }
  }
  return lines.join('\n');
}
