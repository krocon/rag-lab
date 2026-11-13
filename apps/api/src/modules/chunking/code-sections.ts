/**
 * Source code structure needed by the chunker (`format: 'code'`, ADR 0004): boundaries of
 * top-level declarations, recognised line by line with per-language-family heuristics – no parser,
 * deterministic, linear in the text length.
 *
 * A declaration starts on a line **without indentation** that matches a pattern of its family
 * (`export`, `class`, `function`, `interface`, `type`, `const … =`, `def`, `func`, `fn`, top-level
 * tags of Vue/Svelte/Astro/HTML, CSS rules, YAML keys, SQL statements …). Doc comments,
 * decorators/annotations and attributes directly above it (no blank line in between) belong to
 * the declaration. Everything before the first declaration (imports, licence header) is a
 * preamble section without a symbol.
 *
 * Deliberate limits (documented in ADR 0004):
 * - Lines inside template literals or multi-line strings that look like declarations start a
 *   section (harmless: only a cut preference changes).
 * - Nested declarations (methods) are not separate sections; a long class is split inside by the
 *   chunker at blank lines and line ends, and every part keeps the class as its symbol.
 * - Indented top-level code (e.g. HTML templates indented as a whole) has no declarations and is
 *   split at blank lines and line ends only.
 */

export interface CodeSection {
  start: number;
  end: number;
  /** Name of the declaration (`class TreeFactory`), `null` for the preamble or unnamed code. */
  symbol: string | null;
}

type Family = 'script' | 'python' | 'markup' | 'css' | 'yaml' | 'toml' | 'sql' | 'shell' | 'none';

const FAMILY_BY_LANGUAGE: Record<string, Family> = {
  typescript: 'script',
  javascript: 'script',
  java: 'script',
  kotlin: 'script',
  csharp: 'script',
  go: 'script',
  rust: 'script',
  vue: 'markup',
  svelte: 'markup',
  astro: 'markup',
  html: 'markup',
  css: 'css',
  scss: 'css',
  python: 'python',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  shell: 'shell',
  json: 'none',
};

/** A pattern that marks a declaration line and how to name it from the match. */
interface DeclarationPattern {
  pattern: RegExp;
  name(match: RegExpExecArray): string | null;
  /**
   * A decorator/annotation line (`@Component({`): it starts the section of the declaration that
   * follows it without a blank line, which then provides the symbol.
   */
  decorator?: boolean;
}

/** `@Component({` … `})` above `export class` – possibly spanning several lines. */
const DECORATOR_PATTERN: DeclarationPattern = {
  pattern: /^@[A-Za-z_][\w.]*/,
  name: () => null,
  decorator: true,
};

const IDENTIFIER = '[A-Za-z_$][\\w$]*';

/** `kind name` from the named groups `kind` and `name`, or `kind` alone. */
const kindAndName = (match: RegExpExecArray): string | null => {
  const kind = match.groups?.['kind'];
  const name = match.groups?.['name'];
  if (kind && name) {
    return `${kind} ${name}`;
  }
  return name ?? kind ?? null;
};

const SCRIPT_PATTERNS: DeclarationPattern[] = [
  DECORATOR_PATTERN,
  // TypeScript/JavaScript (also Java/Kotlin/C# class-like declarations via modifiers).
  {
    pattern: new RegExp(
      '^(?:export\\s+(?:default\\s+)?)?(?:declare\\s+)?(?:(?:public|private|protected|internal|' +
        'abstract|final|sealed|static|partial|open|data|inline|value|async)\\s+)*' +
        `(?<kind>function\\*?|class|interface|type|enum|namespace|module|record|struct|object|trait)\\s+(?<name>${IDENTIFIER})`,
    ),
    name: (match) => kindAndName(match)?.replace('function*', 'function') ?? null,
  },
  {
    pattern: new RegExp(
      `^(?:export\\s+)?(?:declare\\s+)?(?<kind>const|let|var)\\s+(?<name>${IDENTIFIER})\\b`,
    ),
    name: kindAndName,
  },
  // `export default …`, `export { … }`, `export * from …`.
  { pattern: /^export\s+(?:default\b|\{|\*)/, name: () => null },
  // Kotlin `fun name(`, Go `func (r *T) Name(` / `func Name(`, Rust `pub fn name`.
  {
    pattern: new RegExp(
      `^(?:(?:public|private|internal|protected|override|suspend|inline|pub(?:\\([\\w:]+\\))?|async|unsafe|const|extern(?:\\s+"\\w+")?)\\s+)*` +
        `(?<kind>fun|func|fn)\\s+(?:\\([^)]*\\)\\s*)?(?:<[^>]*>\\s*)?(?<name>[A-Za-z_][\\w.]*)`,
    ),
    name: kindAndName,
  },
  // Rust/Go type-level items: `impl Foo`, `type Foo struct`, `mod foo`, `trait Foo`.
  {
    pattern: new RegExp(
      `^(?:pub(?:\\([\\w:]+\\))?\\s+)?(?<kind>impl|mod|trait|struct|enum|union|type|static)\\b(?:\\s*<[^>]*>)?\\s+(?<name>[A-Za-z_][\\w:<>]*)`,
    ),
    name: kindAndName,
  },
  // Go `var (`, `const (` blocks, Java/C#/Kotlin members at top level are rare.
  { pattern: /^(?:var|const)\s*\(/, name: () => null },
];

const PYTHON_PATTERNS: DeclarationPattern[] = [
  DECORATOR_PATTERN,
  {
    pattern: new RegExp(`^(?:async\\s+)?(?<kind>def|class)\\s+(?<name>${IDENTIFIER})`),
    name: kindAndName,
  },
  // Module-level assignments of constants: `FOO = …`, `foo: int = …`.
  { pattern: /^(?<name>[A-Z][A-Z0-9_]+)\s*(?::[^=]+)?=/, name: (match) => match.groups?.['name'] ?? null },
];

const MARKUP_TAG_PATTERN: DeclarationPattern = {
  // Top-level elements without indentation: `<template>`, `<script setup lang="ts">`, `<div …>`.
  pattern: /^<(?<tag>[A-Za-z][\w:-]*)(?<rest>[^>]*)/,
  name: (match) => {
    const tag = (match.groups?.['tag'] ?? '').toLowerCase();
    const id = /\sid\s*=\s*["']([^"']{1,60})["']/.exec(match.groups?.['rest'] ?? '')?.[1];
    return id ? `<${tag}#${id}>` : `<${tag}>`;
  },
};

const CSS_PATTERNS: DeclarationPattern[] = [
  // At-rules and rules starting at column 0: `@media (…) {`, `.table-row:hover {`, `@mixin x`.
  {
    pattern: /^(?<head>@[\w-]+[^{;]*|[^\s@}/][^{;]*)\{/,
    name: (match) => truncateSymbol((match.groups?.['head'] ?? '').trim()),
  },
  {
    pattern: /^(?<head>@(?:mixin|function|include)\s+[\w-]+)/,
    name: (match) => match.groups?.['head'] ?? null,
  },
];

const YAML_PATTERNS: DeclarationPattern[] = [
  {
    pattern: /^(?<name>[A-Za-z_][\w.-]*|"[^"]+"|'[^']+')\s*:(?:\s|$)/,
    name: (match) => match.groups?.['name'] ?? null,
  },
];

const TOML_PATTERNS: DeclarationPattern[] = [
  { pattern: /^(?<name>\[\[?[^\]]+\]\]?)/, name: (match) => match.groups?.['name'] ?? null },
];

const SQL_PATTERNS: DeclarationPattern[] = [
  {
    pattern:
      /^(?<head>(?:create|alter|drop)\s+(?:or\s+replace\s+)?(?:unique\s+)?(?:table|view|index|function|procedure|trigger|type|schema|sequence|extension|materialized\s+view)(?:\s+if\s+(?:not\s+)?exists)?\s+[\w."]+)/i,
    name: (match) => truncateSymbol((match.groups?.['head'] ?? '').replace(/\s+/g, ' ')),
  },
  { pattern: /^(?:insert|update|delete|select|with|grant|comment)\b/i, name: () => null },
];

const SHELL_PATTERNS: DeclarationPattern[] = [
  {
    pattern: /^(?:function\s+)?(?<name>[A-Za-z_][\w-]*)\s*\(\)\s*\{?/,
    name: (match) => `function ${match.groups?.['name'] ?? ''}`,
  },
];

const PATTERNS_BY_FAMILY: Record<Family, DeclarationPattern[]> = {
  script: SCRIPT_PATTERNS,
  // Vue/Svelte/Astro script blocks contain TypeScript at column 0.
  markup: [MARKUP_TAG_PATTERN, ...SCRIPT_PATTERNS],
  python: PYTHON_PATTERNS,
  css: CSS_PATTERNS,
  yaml: YAML_PATTERNS,
  toml: TOML_PATTERNS,
  sql: SQL_PATTERNS,
  shell: SHELL_PATTERNS,
  none: [],
};

/** Lines that belong to the declaration below them: comments, decorators, annotations. */
const ATTACHMENT_BY_FAMILY: Record<Family, RegExp> = {
  script: /^\s*(?:\/\/|\/\*|\*|@[\w.]+|#\[|\[[A-Z]\w*)/,
  markup: /^\s*(?:\/\/|\/\*|\*|@[\w.]+|<!--)/,
  python: /^\s*(?:#|@[\w.]+)/,
  css: /^\s*(?:\/\/|\/\*|\*)/,
  yaml: /^\s*#/,
  toml: /^\s*#/,
  sql: /^\s*(?:--|\/\*|\*)/,
  shell: /^\s*#(?!!)/,
  none: /(?!)/,
};

/** Maximum length of a symbol name in characters. */
export const MAX_SYMBOL_LENGTH = 80;

function truncateSymbol(value: string): string {
  const characters = Array.from(value);
  return characters.length <= MAX_SYMBOL_LENGTH
    ? value
    : `${characters.slice(0, MAX_SYMBOL_LENGTH - 1).join('')}…`;
}

/** True if `language` uses the code chunker's declaration heuristics (any non-prose language). */
export function isKnownCodeLanguage(language: string): boolean {
  return Object.hasOwn(FAMILY_BY_LANGUAGE, language);
}

/**
 * Splits source code into top-level declaration sections covering `[0, text.length)` without gaps.
 * `language` selects the heuristics (unknown languages: no declarations, one section).
 */
export function splitCodeSections(text: string, language: string | undefined): CodeSection[] {
  const family: Family =
    language !== undefined && Object.hasOwn(FAMILY_BY_LANGUAGE, language)
      ? (FAMILY_BY_LANGUAGE[language] ?? 'none')
      : 'none';
  const patterns = PATTERNS_BY_FAMILY[family];
  const attachment = ATTACHMENT_BY_FAMILY[family];

  const lines = text.split('\n');
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  /** Line index where each section starts, with its symbol. */
  const starts: { line: number; symbol: string | null; openDecorator: boolean }[] = [];
  let previousStartLine = -1;
  lines.forEach((line, index) => {
    if (line.trim() === '') {
      // A blank line ends a pending decorator: it no longer attaches to what follows.
      const last = starts.at(-1);
      if (last) {
        last.openDecorator = false;
      }
      return;
    }
    if (/^\s/.test(line)) {
      return;
    }
    const declaration = matchDeclaration(line, patterns);
    if (declaration === undefined) {
      return;
    }
    const last = starts.at(-1);
    if (last?.openDecorator) {
      // The declaration below a decorator: same section, the declaration names it.
      if (!declaration.decorator) {
        last.symbol = declaration.symbol;
        last.openDecorator = false;
      }
      previousStartLine = index;
      return;
    }
    // Comments, decorators and annotations directly above belong to the declaration.
    let first = index;
    while (
      first - 1 > previousStartLine &&
      (lines[first - 1] ?? '').trim() !== '' &&
      attachment.test(lines[first - 1] ?? '')
    ) {
      first--;
    }
    if (first <= previousStartLine) {
      return;
    }
    starts.push({
      line: first,
      symbol: declaration.symbol,
      openDecorator: declaration.decorator,
    });
    previousStartLine = index;
  });

  const sections: CodeSection[] = [];
  const firstStart = starts[0]?.line ?? lines.length;
  if (firstStart > 0 || starts.length === 0) {
    sections.push({ start: 0, end: 0, symbol: null });
  }
  for (const start of starts) {
    sections.push({ start: lineStarts[start.line] ?? text.length, end: 0, symbol: start.symbol });
  }
  sections.forEach((section, index) => {
    section.end = sections[index + 1]?.start ?? text.length;
  });
  return sections.filter((section) => section.end > section.start || sections.length === 1);
}

function matchDeclaration(
  line: string,
  patterns: readonly DeclarationPattern[],
): { symbol: string | null; decorator: boolean } | undefined {
  for (const { pattern, name, decorator = false } of patterns) {
    const match = pattern.exec(line);
    if (match) {
      const symbol = name(match);
      return { symbol: symbol === null ? null : truncateSymbol(symbol), decorator };
    }
  }
  return undefined;
}
