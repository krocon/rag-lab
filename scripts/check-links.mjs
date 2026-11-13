#!/usr/bin/env node
// @ts-check
/**
 * Checks relative links and #anchors in the repository's Markdown documentation.
 *
 *   pnpm docs:links
 *
 * Checked: every *.md outside node_modules, build output and `prompts/done/` (finished work
 * prompts are historical and may mention files that were planned at the time). External URLs are
 * not fetched. Exits 1 and lists every broken link.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDocument } from './docs/link-lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.angular', '.git', '.idea']);
const SKIP_PATHS = new Set([join('prompts', 'done'), join('eval', 'results'), 'kb-import']);

/** @param {string} dir @returns {string[]} */
function markdownFiles(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      if (SKIP_PATHS.has(relative(root, path))) continue;
      files.push(...markdownFiles(path));
    } else if (entry.name.toLowerCase().endsWith('.md')) {
      files.push(path);
    }
  }
  return files;
}

const files = markdownFiles(root);
let broken = 0;
for (const file of files) {
  const problems = checkDocument({
    file,
    markdown: readFileSync(file, 'utf8'),
    resolve: (from, target) =>
      target.startsWith('/') ? join(root, target) : resolve(dirname(from), target),
    exists: existsSync,
    readMarkdown: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
  });
  for (const { line, target, problem } of problems) {
    console.error(`${relative(root, file)}:${line}  ${target}  – ${problem}`);
    broken++;
  }
}
if (broken > 0) {
  console.error(`\n${broken} broken link(s) in ${files.length} Markdown files.`);
  process.exit(1);
}
console.log(`Checked ${files.length} Markdown files: no broken relative links.`);
