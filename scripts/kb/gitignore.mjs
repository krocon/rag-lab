// @ts-check
/**
 * A small gitignore matcher for `pnpm kb:import` (no dependency): `.gitignore` files outside a Git
 * work tree, `.raglabignore`, `--exclude` and `--include`. Implements the gitignore rules that
 * matter for selecting files (https://git-scm.com/docs/gitignore#_pattern_format):
 *
 * - blank lines and `#` comments are skipped, `\#` and `\!` escape, trailing spaces are trimmed;
 * - `!pattern` re-includes; the last matching rule wins;
 * - `dir/` matches directories only; a pattern with a `/` (other than a trailing one) is relative
 *   to the directory of its file, otherwise it matches a name at any depth below it;
 * - `*`, `?`, `[a-z]`/`[!a-z]` do not match `/`; `**` matches across directories
 *   (`**\/x`, `a/**`, `a/**\/b`);
 * - a file inside an ignored directory is ignored – a negation cannot re-include it (as in Git).
 *
 * Paths are relative, use `/` and have no leading `./`.
 */

/**
 * @typedef {{ regex: RegExp, negate: boolean, dirOnly: boolean, source: string }} IgnoreRule
 */

/**
 * Converts a gitignore glob (without `!`, leading or trailing `/`) to a regular expression source
 * that matches a whole relative path.
 * @param {string} glob
 */
function globToRegexSource(glob) {
  let source = '';
  let index = 0;
  while (index < glob.length) {
    const rest = glob.slice(index);
    if (rest.startsWith('**/') && (index === 0 || glob[index - 1] === '/')) {
      source += '(?:.*/)?';
      index += 3;
      continue;
    }
    if (rest === '**' && (index === 0 || glob[index - 1] === '/')) {
      source += '.*';
      index += 2;
      continue;
    }
    const char = glob[index] ?? '';
    if (char === '\\' && index + 1 < glob.length) {
      source += escapeRegex(glob[index + 1] ?? '');
      index += 2;
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[') {
      const close = glob.indexOf(']', index + 2);
      if (close === -1) {
        source += '\\[';
      } else {
        let body = glob.slice(index + 1, close);
        if (body.startsWith('!')) {
          body = `^${body.slice(1)}`;
        }
        source += `[${body.replace(/\\/g, '\\\\')}]`;
        index = close;
      }
    } else {
      source += escapeRegex(char);
    }
    index += 1;
  }
  return source;
}

/** @param {string} value */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Parses one line of an ignore file into a rule, or `undefined` for blank lines and comments.
 * @param {string} line
 * @param {string} [baseDir] directory of the ignore file relative to the root (`''` = root)
 * @returns {IgnoreRule | undefined}
 */
export function parseIgnoreLine(line, baseDir = '') {
  let pattern = line.replace(/\r$/, '');
  // Trailing spaces are ignored unless escaped with a backslash.
  pattern = pattern.replace(/(?<!\\)\s+$/, '');
  if (pattern === '' || pattern.startsWith('#')) {
    return undefined;
  }
  let negate = false;
  if (pattern.startsWith('!')) {
    negate = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith('\\!') || pattern.startsWith('\\#')) {
    pattern = pattern.slice(1);
  }
  let dirOnly = false;
  if (pattern.endsWith('/')) {
    dirOnly = true;
    pattern = pattern.replace(/\/+$/, '');
  }
  if (pattern === '') {
    return undefined;
  }
  const anchored = pattern.includes('/');
  pattern = pattern.replace(/^\/+/, '');
  const base = baseDir === '' ? '' : `${escapeRegex(baseDir)}/`;
  const glob = globToRegexSource(pattern);
  const source = anchored ? `^${base}${glob}$` : `^${base}(?:.*/)?${glob}$`;
  return { regex: new RegExp(source), negate, dirOnly, source: line };
}

/**
 * An ordered set of ignore rules (later rules win).
 */
export class IgnoreMatcher {
  constructor() {
    /** @type {IgnoreRule[]} */
    this.rules = [];
  }

  /**
   * Adds the rules of an ignore file's text (or a list of patterns).
   * @param {string | string[]} patterns
   * @param {string} [baseDir] directory of the ignore file relative to the root
   */
  add(patterns, baseDir = '') {
    const lines = Array.isArray(patterns) ? patterns : patterns.split('\n');
    for (const line of lines) {
      const rule = parseIgnoreLine(line, baseDir);
      if (rule) {
        this.rules.push(rule);
      }
    }
    return this;
  }

  /**
   * Result of the last rule matching exactly this path: `true` ignored, `false` re-included,
   * `undefined` no rule matches.
   * @param {string} path
   * @param {boolean} isDirectory
   */
  test(path, isDirectory) {
    /** @type {boolean | undefined} */
    let result;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDirectory) {
        continue;
      }
      if (rule.regex.test(path)) {
        result = !rule.negate;
      }
    }
    return result;
  }

  /**
   * True if the path – or one of its parent directories – is ignored.
   * @param {string} path relative path with `/`
   * @param {boolean} [isDirectory]
   */
  ignores(path, isDirectory = false) {
    const segments = path.split('/');
    for (let length = 1; length < segments.length; length++) {
      if (this.test(segments.slice(0, length).join('/'), true) === true) {
        return true;
      }
    }
    return this.test(path, isDirectory) === true;
  }
}
