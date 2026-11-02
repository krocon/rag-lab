import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { findAtxHeadings } from '../modules/chunking/markdown-sections.js';
import { normalizeText } from '../modules/ingestion/normalize.js';

/**
 * Evaluation dataset (format: eval/README.md): Markdown/TXT documents plus `queries.jsonl` with
 * one question per line and its relevance anchors. Anchors reference stable parts of the text –
 * document name, heading text or a text marker – never chunk ids, so changing the chunking does not
 * break the gold labels.
 */

export const QUERIES_FILE = 'queries.jsonl';
const DOCUMENT_EXTENSIONS = ['.md', '.txt'];

const anchorSchema = z
  .strictObject({
    /** File name of a dataset document. */
    document: z.string().min(1),
    /** Exact text of a Markdown heading of that document (unique within the document). */
    heading: z.string().trim().min(1).optional(),
    /** Literal text of that document (unique; whitespace differences are ignored). */
    marker: z.string().trim().min(3).optional(),
  })
  .refine((anchor) => !(anchor.heading && anchor.marker), {
    message: 'an anchor has either "heading" or "marker", not both',
  });

const querySchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'id must be 1-64 letters, digits, "-" or "_"'),
  query: z.string().trim().min(1),
  relevant: z.array(anchorSchema).min(1, 'at least one relevant anchor is required'),
});

export type RawAnchor = z.infer<typeof anchorSchema>;

/** A validated relevance anchor with a stable id (used in results and metrics). */
export interface Anchor {
  id: string;
  document: string;
  heading?: string;
  marker?: string;
}

export interface EvalQuery {
  id: string;
  query: string;
  anchors: Anchor[];
}

export interface DatasetDocument {
  filename: string;
  /** Raw file content (uploaded as is; the server normalises it). */
  raw: string;
}

export interface EvalDataset {
  name: string;
  documents: DatasetDocument[];
  queries: EvalQuery[];
  /** SHA-256 over all documents and the queries – identifies the dataset version in results. */
  sha256: string;
}

export class DatasetError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid evaluation dataset:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'DatasetError';
  }
}

/** Collapses runs of whitespace so markers may span line breaks. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (
    let index = haystack.indexOf(needle);
    index !== -1;
    index = haystack.indexOf(needle, index + 1)
  ) {
    count++;
  }
  return count;
}

export function anchorId(anchor: RawAnchor): string {
  if (anchor.heading) {
    return `${anchor.document}#${anchor.heading}`;
  }
  if (anchor.marker) {
    return `${anchor.document}~"${collapseWhitespace(anchor.marker)}"`;
  }
  return anchor.document;
}

/**
 * Validates documents and queries (pure, no I/O). Collects every problem instead of stopping at
 * the first one and throws a {@link DatasetError} listing them.
 */
export function parseDataset(
  name: string,
  documents: readonly DatasetDocument[],
  queriesJsonl: string,
): EvalDataset {
  const issues: string[] = [];
  const byName = new Map<string, { headings: string[]; collapsed: string }>();
  for (const document of documents) {
    const text = normalizeText(document.raw);
    if (text.trim().length === 0) {
      issues.push(`${document.filename}: document is empty`);
    }
    const headings = document.filename.endsWith('.md')
      ? findAtxHeadings(text).map((heading) => heading.text)
      : [];
    byName.set(document.filename, { headings, collapsed: collapseWhitespace(text) });
  }

  const queries: EvalQuery[] = [];
  const ids = new Set<string>();
  queriesJsonl.split('\n').forEach((line, index) => {
    const where = `${QUERIES_FILE}:${index + 1}`;
    if (line.trim().length === 0) {
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      issues.push(`${where}: not valid JSON`);
      return;
    }
    const parsed = querySchema.safeParse(json);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push(`${where}: ${issue.path.join('.') || '(line)'}: ${issue.message}`);
      }
      return;
    }
    const { id, query, relevant } = parsed.data;
    if (ids.has(id)) {
      issues.push(`${where}: duplicate query id "${id}"`);
    }
    ids.add(id);

    const anchors: Anchor[] = [];
    for (const raw of relevant) {
      const document = byName.get(raw.document);
      const anchor: Anchor = {
        id: anchorId(raw),
        document: raw.document,
        ...(raw.heading !== undefined ? { heading: raw.heading } : {}),
        ...(raw.marker !== undefined ? { marker: raw.marker } : {}),
      };
      if (!document) {
        issues.push(`${where} (${id}): unknown document "${raw.document}"`);
        continue;
      }
      if (raw.heading !== undefined) {
        const matches = document.headings.filter((heading) => heading === raw.heading).length;
        if (matches === 0) {
          issues.push(`${where} (${id}): unknown heading "${raw.heading}" in ${raw.document}`);
        } else if (matches > 1) {
          issues.push(
            `${where} (${id}): heading "${raw.heading}" is not unique in ${raw.document}`,
          );
        }
      }
      if (raw.marker !== undefined) {
        const matches = countOccurrences(document.collapsed, collapseWhitespace(raw.marker));
        if (matches === 0) {
          issues.push(`${where} (${id}): marker "${raw.marker}" not found in ${raw.document}`);
        } else if (matches > 1) {
          issues.push(`${where} (${id}): marker "${raw.marker}" is not unique in ${raw.document}`);
        }
      }
      if (anchors.some((existing) => existing.id === anchor.id)) {
        issues.push(`${where} (${id}): duplicate anchor ${anchor.id}`);
        continue;
      }
      anchors.push(anchor);
    }
    queries.push({ id, query, anchors });
  });

  if (documents.length === 0) {
    issues.push('the dataset contains no documents (.md or .txt)');
  }
  if (queries.length === 0 && issues.length === 0) {
    issues.push(`${QUERIES_FILE} contains no queries`);
  }
  if (issues.length > 0) {
    throw new DatasetError(issues);
  }

  const hash = createHash('sha256');
  for (const document of [...documents].sort((a, b) => a.filename.localeCompare(b.filename))) {
    hash.update(`${document.filename}\0${document.raw}\0`);
  }
  hash.update(queriesJsonl);
  return { name, documents: [...documents], queries, sha256: hash.digest('hex') };
}

/** Reads a dataset directory: every `.md`/`.txt` file is a document, plus `queries.jsonl`. */
export async function loadDataset(directory: string): Promise<EvalDataset> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    throw new DatasetError([`dataset directory not found: ${directory}`]);
  }
  if (!entries.includes(QUERIES_FILE)) {
    throw new DatasetError([`${QUERIES_FILE} is missing in ${directory}`]);
  }
  const filenames = entries
    .filter((entry) => DOCUMENT_EXTENSIONS.some((extension) => entry.endsWith(extension)))
    .sort();
  const documents = await Promise.all(
    filenames.map(async (filename) => ({
      filename,
      raw: await readFile(join(directory, filename), 'utf8'),
    })),
  );
  const queries = await readFile(join(directory, QUERIES_FILE), 'utf8');
  return parseDataset(basename(directory), documents, queries);
}

/** What anchor matching needs from a retrieved or stored chunk. */
export interface ChunkRef {
  filename: string;
  headingPath: readonly string[];
  content: string;
}

/**
 * Whether a chunk lies in the part of the text an anchor points to:
 * - document only → any chunk of that document,
 * - heading → the chunk's heading path contains the heading (chunks never span two sections,
 *   so this covers the section and its subsections),
 * - marker → the chunk contains the whole marker (whitespace-insensitive).
 */
export function anchorMatches(anchor: Anchor, chunk: ChunkRef): boolean {
  if (chunk.filename !== anchor.document) {
    return false;
  }
  if (anchor.heading !== undefined) {
    return chunk.headingPath.includes(anchor.heading);
  }
  if (anchor.marker !== undefined) {
    return collapseWhitespace(chunk.content).includes(collapseWhitespace(anchor.marker));
  }
  return true;
}

/** Ids of the anchors a chunk matches, in anchor order. */
export function matchedAnchorIds(anchors: readonly Anchor[], chunk: ChunkRef): string[] {
  return anchors.filter((anchor) => anchorMatches(anchor, chunk)).map((anchor) => anchor.id);
}

/**
 * Anchors that no stored chunk matches – e.g. a marker cut in two by a chunk boundary. They can
 * never be found at section level and are reported with the run.
 */
export function unresolvedAnchors(
  queries: readonly EvalQuery[],
  chunks: readonly ChunkRef[],
): string[] {
  const unresolved = new Set<string>();
  for (const query of queries) {
    for (const anchor of query.anchors) {
      if (!chunks.some((chunk) => anchorMatches(anchor, chunk))) {
        unresolved.add(anchor.id);
      }
    }
  }
  return [...unresolved].sort();
}
