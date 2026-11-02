import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  anchorMatches,
  DatasetError,
  loadDataset,
  matchedAnchorIds,
  parseDataset,
  unresolvedAnchors,
  type Anchor,
  type ChunkRef,
} from '../../src/eval/dataset.js';
import { chunkText } from '../../src/modules/chunking/chunker.js';

const GUIDE = [
  '# Guide',
  '',
  'Intro text.',
  '',
  '## Install',
  '',
  'Run the installer and wait for the',
  'green check mark.',
  '',
  '## Usage',
  '',
  'Open the app.',
  '',
].join('\n');
const NOTES = 'Plain notes about backups.\nKeep three copies.\n';
const documents = [
  { filename: 'guide.md', raw: GUIDE },
  { filename: 'notes.txt', raw: NOTES },
];

const line = (value: object) => JSON.stringify(value);

function issuesOf(queries: string): string[] {
  try {
    parseDataset('test', documents, queries);
  } catch (error) {
    if (error instanceof DatasetError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error('expected a DatasetError');
}

describe('parseDataset', () => {
  it('parses queries with document, heading and marker anchors', () => {
    const dataset = parseDataset(
      'test',
      documents,
      [
        line({
          id: 'q1',
          query: ' How to install? ',
          relevant: [{ document: 'guide.md', heading: 'Install' }],
        }),
        '',
        line({
          id: 'q2',
          query: 'backups',
          relevant: [
            { document: 'notes.txt' },
            { document: 'guide.md', marker: 'for the green check' },
          ],
        }),
      ].join('\n'),
    );
    expect(dataset.queries).toEqual([
      {
        id: 'q1',
        query: 'How to install?',
        anchors: [{ id: 'guide.md#Install', document: 'guide.md', heading: 'Install' }],
      },
      {
        id: 'q2',
        query: 'backups',
        anchors: [
          { id: 'notes.txt', document: 'notes.txt' },
          {
            id: 'guide.md~"for the green check"',
            document: 'guide.md',
            marker: 'for the green check',
          },
        ],
      },
    ]);
    expect(dataset.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the hash when a document changes', () => {
    const queries = line({ id: 'q1', query: 'x', relevant: [{ document: 'notes.txt' }] });
    const a = parseDataset('t', documents, queries).sha256;
    const b = parseDataset(
      't',
      [
        { filename: 'guide.md', raw: GUIDE },
        { filename: 'notes.txt', raw: `${NOTES}more` },
      ],
      queries,
    ).sha256;
    expect(a).not.toBe(b);
  });

  it('reports unknown documents, headings and markers with line numbers', () => {
    expect(
      issuesOf(
        [
          line({ id: 'q1', query: 'a', relevant: [{ document: 'missing.md' }] }),
          line({
            id: 'q2',
            query: 'b',
            relevant: [{ document: 'guide.md', heading: 'Uninstall' }],
          }),
          line({
            id: 'q3',
            query: 'c',
            relevant: [{ document: 'notes.txt', marker: 'four copies' }],
          }),
          line({ id: 'q4', query: 'd', relevant: [{ document: 'notes.txt', heading: 'Notes' }] }),
        ].join('\n'),
      ),
    ).toEqual([
      'queries.jsonl:1 (q1): unknown document "missing.md"',
      'queries.jsonl:2 (q2): unknown heading "Uninstall" in guide.md',
      'queries.jsonl:3 (q3): marker "four copies" not found in notes.txt',
      'queries.jsonl:4 (q4): unknown heading "Notes" in notes.txt',
    ]);
  });

  it('rejects ambiguous markers, duplicate ids and duplicate anchors', () => {
    const issues = issuesOf(
      [
        line({ id: 'q1', query: 'a', relevant: [{ document: 'guide.md', marker: 'the' }] }),
        line({
          id: 'q1',
          query: 'b',
          relevant: [{ document: 'notes.txt' }, { document: 'notes.txt' }],
        }),
      ].join('\n'),
    );
    expect(issues).toEqual([
      'queries.jsonl:1 (q1): marker "the" is not unique in guide.md',
      'queries.jsonl:2: duplicate query id "q1"',
      'queries.jsonl:2 (q1): duplicate anchor notes.txt',
    ]);
  });

  it('validates the line format with zod', () => {
    const issues = issuesOf(
      [
        '{not json',
        line({ id: 'bad id!', query: '', relevant: [] }),
        line({
          id: 'q3',
          query: 'x',
          relevant: [{ document: 'guide.md', heading: 'Install', marker: 'Run' }],
        }),
        line({ id: 'q4', query: 'x', relevant: [{ document: 'guide.md' }], extra: true }),
      ].join('\n'),
    );
    expect(issues[0]).toBe('queries.jsonl:1: not valid JSON');
    expect(issues.some((issue) => issue.startsWith('queries.jsonl:2: id:'))).toBe(true);
    expect(issues.some((issue) => issue.startsWith('queries.jsonl:2: query:'))).toBe(true);
    expect(issues).toContain('queries.jsonl:2: relevant: at least one relevant anchor is required');
    expect(issues).toContain(
      'queries.jsonl:3: relevant.0: an anchor has either "heading" or "marker", not both',
    );
    expect(issues.some((issue) => issue.startsWith('queries.jsonl:4: (line):'))).toBe(true);
  });

  it('requires documents and queries', () => {
    expect(() => parseDataset('t', [], '')).toThrow(/no documents/);
    expect(() => parseDataset('t', documents, '\n')).toThrow(/contains no queries/);
  });
});

describe('loadDataset', () => {
  it('loads and validates the bundled raglab-docs dataset', async () => {
    const directory = fileURLToPath(
      new URL('../../../../eval/datasets/raglab-docs', import.meta.url),
    );
    const dataset = await loadDataset(directory);
    expect(dataset.name).toBe('raglab-docs');
    expect(dataset.documents.length).toBeGreaterThanOrEqual(10);
    expect(dataset.documents.length).toBeLessThanOrEqual(20);
    expect(dataset.queries.length).toBeGreaterThanOrEqual(25);
    expect(dataset.queries.length).toBeLessThanOrEqual(50);
  });

  it('fails clearly for a missing directory', async () => {
    await expect(loadDataset('/nonexistent/raglab-eval')).rejects.toThrow(/directory not found/);
  });
});

describe('anchor resolution (document / heading / marker → chunks)', () => {
  const chunksOf = (filename: string, text: string, targetSize = 60): ChunkRef[] =>
    chunkText(text, {
      targetSize,
      overlap: 0,
      format: filename.endsWith('.md') ? 'markdown' : 'text',
    }).map((draft) => ({ filename, headingPath: draft.headingPath, content: draft.content }));

  const install: Anchor = { id: 'guide.md#Install', document: 'guide.md', heading: 'Install' };
  const marker: Anchor = {
    id: 'guide.md~"wait for the green check mark"',
    document: 'guide.md',
    marker: 'wait for the green check mark',
  };
  const wholeNotes: Anchor = { id: 'notes.txt', document: 'notes.txt' };

  it('maps heading anchors to the chunks of that section', () => {
    const chunks = chunksOf('guide.md', GUIDE);
    const matching = chunks.filter((chunk) => anchorMatches(install, chunk));
    expect(matching.length).toBeGreaterThan(0);
    expect(matching.every((chunk) => chunk.headingPath.at(-1) === 'Install')).toBe(true);
    expect(
      chunks.some((chunk) => chunk.headingPath.at(-1) === 'Usage' && anchorMatches(install, chunk)),
    ).toBe(false);
  });

  it('matches markers across line breaks and maps document anchors to every chunk', () => {
    const chunks = chunksOf('guide.md', GUIDE, 200);
    expect(chunks.filter((chunk) => anchorMatches(marker, chunk))).toHaveLength(1);
    const notes = chunksOf('notes.txt', NOTES);
    expect(notes.every((chunk) => anchorMatches(wholeNotes, chunk))).toBe(true);
    expect(chunks.some((chunk) => anchorMatches(wholeNotes, chunk))).toBe(false);
  });

  it('lists the anchors a chunk matches', () => {
    const chunk = chunksOf('guide.md', GUIDE, 200).find((candidate) =>
      candidate.headingPath.includes('Install'),
    );
    if (!chunk) {
      throw new Error('no Install chunk');
    }
    expect(matchedAnchorIds([wholeNotes, install, marker], chunk)).toEqual([install.id, marker.id]);
  });

  it('reports anchors that no chunk contains completely (marker cut by a boundary)', () => {
    const queries = [{ id: 'q', query: 'x', anchors: [install, marker] }];
    expect(unresolvedAnchors(queries, chunksOf('guide.md', GUIDE, 200))).toEqual([]);
    // Small chunks cut the marker in two.
    expect(unresolvedAnchors(queries, chunksOf('guide.md', GUIDE, 25))).toEqual([marker.id]);
  });
});
