// @ts-check
/**
 * Relative-link check for the Markdown documentation (`pnpm docs:links`, scripts/check-links.mjs).
 * Small on purpose instead of a link-checker dependency: it only checks what the repository
 * controls – relative links and images to files/directories, and `#anchors` to Markdown headings
 * (GitHub's slug rules). External URLs are not fetched (no network in CI tests, flaky by nature).
 */

/**
 * GitHub-style heading slug: lower case, Markdown punctuation and other symbols removed, spaces to
 * hyphens. `## 2. Chunking (deterministisch)` → `2-chunking-deterministisch`,
 * `## Security & limitations` → `security--limitations`.
 * @param {string} heading
 */
export function slugify(heading) {
  return heading
    .replace(/<[^>]+>/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Replaces fenced code blocks and inline code with blanks (keeps line numbers). */
function stripCode(markdown) {
  const lines = markdown.split('\n');
  let fence = '';
  return lines
    .map((line) => {
      const match = line.match(/^\s*(`{3,}|~{3,})/);
      if (fence) {
        if (match && match[1].startsWith(fence)) fence = '';
        return '';
      }
      if (match) {
        fence = match[1];
        return '';
      }
      return line.replace(/(`+)(?:(?!\1).)+?\1/g, (code) => ' '.repeat(code.length));
    })
    .join('\n');
}

/**
 * Anchors defined by the headings of a Markdown document (duplicates get `-1`, `-2`, … like on
 * GitHub).
 * @param {string} markdown
 * @returns {Set<string>}
 */
export function headingAnchors(markdown) {
  const anchors = new Set();
  /** @type {Map<string, number>} */
  const seen = new Map();
  let fence = '';
  for (const line of markdown.split('\n')) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (fenceMatch && fenceMatch[1].startsWith(fence)) fence = '';
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!heading) continue;
    const base = slugify(heading[1].replace(/`/g, ''));
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

/**
 * Link targets in a Markdown document: inline links/images `[x](target)`, reference definitions
 * `[x]: target` and HTML `href`/`src` attributes. Code is ignored.
 * @param {string} markdown
 * @returns {{ target: string, line: number }[]}
 */
export function extractLinks(markdown) {
  /** @type {{ target: string, line: number }[]} */
  const links = [];
  stripCode(markdown)
    .split('\n')
    .forEach((text, index) => {
      const line = index + 1;
      for (const match of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
        links.push({ target: match[1], line });
      }
      const definition = text.match(/^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+.*)?$/);
      if (definition) links.push({ target: definition[1], line });
      for (const match of text.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
        links.push({ target: match[1], line });
      }
    });
  return links;
}

/** True for targets the check skips: URLs with a scheme (`https:`, `mailto:`) and `//host`. */
export function isExternal(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//');
}

/**
 * Checks the relative links of one document.
 * @param {{
 *   file: string,
 *   markdown: string,
 *   resolve: (from: string, target: string) => string,
 *   exists: (path: string) => boolean,
 *   readMarkdown: (path: string) => string | undefined,
 * }} input  `resolve` joins the document's directory with a (decoded) path, `readMarkdown` returns
 *           the text of a Markdown file (for anchors) or undefined.
 * @returns {{ line: number, target: string, problem: string }[]}
 */
export function checkDocument({ file, markdown, resolve, exists, readMarkdown }) {
  /** @type {{ line: number, target: string, problem: string }[]} */
  const problems = [];
  for (const { target, line } of extractLinks(markdown)) {
    if (isExternal(target)) continue;
    const hashIndex = target.indexOf('#');
    const rawPath = hashIndex === -1 ? target : target.slice(0, hashIndex);
    const anchor = hashIndex === -1 ? '' : target.slice(hashIndex + 1);
    let path = file;
    if (rawPath) {
      path = resolve(file, decodeURIComponent(rawPath.split('?')[0]));
      if (!exists(path)) {
        problems.push({ line, target, problem: 'file not found' });
        continue;
      }
    }
    if (anchor && /\.md$/i.test(path)) {
      const text = path === file ? markdown : readMarkdown(path);
      if (text !== undefined && !headingAnchors(text).has(decodeURIComponent(anchor))) {
        problems.push({ line, target, problem: `no heading for #${anchor}` });
      }
    }
  }
  return problems;
}
