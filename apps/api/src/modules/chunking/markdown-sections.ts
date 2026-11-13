/**
 * Markdown structure needed by the chunker (and the title extraction of the ingestion module):
 * ATX headings outside fenced code blocks and outside a leading YAML front matter block.
 *
 * Deliberate limits (docs/adr/0002-rag-pipeline.md §2):
 * - Setext headings (`Title` underlined with `===`/`---`) are **not** recognised – they are rare in
 *   technical docs, and `---` is ambiguous (thematic break, front matter).
 * - Headings inside blockquotes, lists or HTML blocks are not recognised.
 * - Headings with an empty text (`# `) are ignored.
 */

export interface MarkdownHeading {
  /** 1 (`#`) … 6 (`######`). */
  level: number;
  /** Heading text without hashes, closing hashes and surrounding whitespace. */
  text: string;
  /** Offset of the first character of the heading line. */
  start: number;
}

/** A heading section: from a heading line (or the document start) up to the next heading. */
export interface MarkdownSection {
  start: number;
  end: number;
  /** Texts of the enclosing headings, outermost first; `[]` before the first heading. */
  headingPath: string[];
  /** End of the heading line (its line break); `start` for the part before the first heading. */
  bodyStart: number;
  /** Level of the heading that opens the section; 0 for the part before the first heading. */
  level: number;
  /** True if the section consists of the heading line only (plus whitespace). */
  headingOnly: boolean;
}

const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const FRONT_MATTER_END = /^(---|\.\.\.)\s*$/;

/** All ATX headings in document order (see the module comment for what is recognised). */
export function findAtxHeadings(text: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const lines = text.split('\n');
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  let index = 0;
  if (lines[0]?.trimEnd() === '---') {
    const end = lines.findIndex((line, i) => i > 0 && FRONT_MATTER_END.test(line));
    if (end !== -1) {
      index = end + 1;
    }
  }

  let openFence: string | undefined;
  for (; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const fence = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      if (openFence === undefined) {
        openFence = fence;
      } else if (fence[0] === openFence[0] && fence.length >= openFence.length) {
        openFence = undefined;
      }
      continue;
    }
    if (openFence !== undefined) {
      continue;
    }
    const match = ATX_HEADING.exec(line);
    const hashes = match?.[1];
    const headingText = match?.[2]?.trim();
    if (hashes && headingText) {
      headings.push({ level: hashes.length, text: headingText, start: lineStarts[index] ?? 0 });
    }
  }
  return headings;
}

/**
 * Splits a Markdown text into heading sections that cover the text without gaps. The heading
 * path is maintained as a stack, so level jumps (`#` → `###`) yield `[h1, h3]`.
 */
export function splitMarkdownSections(text: string): MarkdownSection[] {
  const headings = findAtxHeadings(text);
  const sections: MarkdownSection[] = [];
  const firstStart = headings[0]?.start ?? text.length;
  if (firstStart > 0) {
    sections.push({
      start: 0,
      end: firstStart,
      headingPath: [],
      bodyStart: 0,
      level: 0,
      headingOnly: false,
    });
  }

  const stack: MarkdownHeading[] = [];
  headings.forEach((heading, i) => {
    while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= heading.level) {
      stack.pop();
    }
    stack.push(heading);
    const end = headings[i + 1]?.start ?? text.length;
    const lineEnd = text.indexOf('\n', heading.start);
    const bodyStart = lineEnd === -1 || lineEnd > end ? end : lineEnd;
    sections.push({
      start: heading.start,
      end,
      headingPath: stack.map((entry) => entry.text),
      bodyStart,
      level: heading.level,
      headingOnly: text.slice(bodyStart, end).trim().length === 0,
    });
  });
  return sections;
}

/** A fenced code block: from the start of its opening fence line to the end of its closing one. */
export interface FencedBlock {
  start: number;
  /** End of the closing fence line (before its line break); text end for an unclosed fence. */
  end: number;
}

/**
 * Fenced code blocks (```` ``` ```` or `~~~`, same rules as {@link findAtxHeadings}) in document
 * order. The chunker prefers not to cut inside them.
 */
export function findFencedBlocks(text: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  let offset = 0;
  let open: { fence: string; start: number } | undefined;
  for (const line of text.split('\n')) {
    const fence = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      if (open === undefined) {
        open = { fence, start: offset };
      } else if (fence[0] === open.fence[0] && fence.length >= open.fence.length) {
        blocks.push({ start: open.start, end: offset + line.length });
        open = undefined;
      }
    }
    offset += line.length + 1;
  }
  if (open !== undefined) {
    blocks.push({ start: open.start, end: text.length });
  }
  return blocks;
}
