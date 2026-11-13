import { describe, expect, it } from 'vitest';
import { splitCodeSections } from '../../src/modules/chunking/code-sections.js';

/** Section texts with their symbols, for readable expectations. */
function sections(text: string, language: string) {
  return splitCodeSections(text, language).map((section) => ({
    symbol: section.symbol,
    text: text.slice(section.start, section.end),
  }));
}

describe('splitCodeSections', () => {
  it('covers the text without gaps', () => {
    const text = "import x from 'x';\n\nexport class A {}\n\nexport function b() {}\n";
    const result = splitCodeSections(text, 'typescript');
    expect(result[0]?.start).toBe(0);
    expect(result.at(-1)?.end).toBe(text.length);
    result.forEach((section, index) => {
      if (index > 0) {
        expect(section.start).toBe(result[index - 1]?.end);
      }
    });
  });

  it('splits TypeScript at top-level declarations and keeps imports as preamble', () => {
    const text = [
      "import { a } from './a';",
      '',
      'export type Id = string;',
      'export interface Row {',
      '  id: Id;',
      '}',
      'const limit = 10;',
      'export default function main() {}',
      'export enum Mode { A }',
      'declare namespace NS {}',
      'export abstract class Base {}',
      'export async function load() {}',
      'export { a };',
    ].join('\n');
    expect(sections(text, 'typescript').map((section) => section.symbol)).toEqual([
      null,
      'type Id',
      'interface Row',
      'const limit',
      'function main',
      'enum Mode',
      'namespace NS',
      'class Base',
      'function load',
      null,
    ]);
  });

  it('attaches doc comments and decorators (also multi-line ones) to the declaration', () => {
    const text = [
      'const a = 1;',
      '',
      '/**',
      ' * Docs.',
      ' */',
      '@Component({',
      "  selector: 'x',",
      '})',
      'export class Widget {',
      '  @Input() value = 1;',
      '}',
    ].join('\n');
    const result = sections(text, 'typescript');
    expect(result).toHaveLength(2);
    expect(result[1]?.symbol).toBe('class Widget');
    expect(result[1]?.text.startsWith('/**')).toBe(true);
  });

  it('does not treat indented code as a declaration', () => {
    const text = 'export class A {\n  class = 1;\n  function x() {}\n}\n';
    expect(sections(text, 'typescript')).toHaveLength(1);
  });

  it('recognises Python, Go, Rust, Kotlin and Java declarations', () => {
    const symbols = (text: string, language: string) =>
      sections(text, language).map((section) => section.symbol);
    expect(
      symbols('import os\n\n@dataclass\nclass Row:\n    pass\n\ndef build():\n    pass\n', 'python'),
    ).toEqual([null, 'class Row', 'def build']);
    expect(symbols('package x\n\ntype Row struct{}\n\nfunc (r *Row) Name() string {}\n', 'go')).toEqual(
      [null, 'type Row', 'func Name'],
    );
    expect(
      symbols('use std::fmt;\n\npub struct Row;\n\nimpl Row {}\n\npub fn build() {}\n', 'rust'),
    ).toEqual([null, 'struct Row', 'impl Row', 'fn build']);
    expect(symbols('fun main() {}\n', 'kotlin')).toEqual(['fun main']);
    expect(symbols('package a;\n\npublic final class Tree {}\n', 'java')).toEqual([
      null,
      'class Tree',
    ]);
  });

  it('splits Vue single-file components at top-level tags and script declarations', () => {
    const text = [
      '<template>',
      '  <div />',
      '</template>',
      '',
      '<script setup lang="ts">',
      "import { ref } from 'vue';",
      'const count = ref(0);',
      '</script>',
      '<style scoped>',
      '.a {}',
      '</style>',
    ].join('\n');
    expect(sections(text, 'vue').map((section) => section.symbol)).toEqual([
      '<template>',
      '<script>',
      'const count',
      '<style>',
    ]);
  });

  it('names HTML elements with their id', () => {
    const text = '<section id="intro">\n</section>\n<div>\n</div>\n';
    expect(sections(text, 'html').map((section) => section.symbol)).toEqual([
      '<section#intro>',
      '<div>',
    ]);
  });

  it('recognises CSS rules, YAML keys, TOML tables, SQL statements and shell functions', () => {
    const symbols = (text: string, language: string) =>
      sections(text, language).map((section) => section.symbol);
    expect(symbols('.a {\n}\n@media (x) {\n}\n', 'css')).toEqual(['.a', '@media (x)']);
    expect(symbols('# comment\nname: x\njobs:\n  build: y\n', 'yaml')).toEqual(['name', 'jobs']);
    expect(symbols('[package]\nname = "x"\n[[bin]]\n', 'toml')).toEqual(['[package]', '[[bin]]']);
    expect(symbols('-- users\nCREATE TABLE IF NOT EXISTS users (\n id int\n);\n', 'sql')).toEqual([
      'CREATE TABLE IF NOT EXISTS users',
    ]);
    expect(symbols('#!/bin/sh\nset -e\nbuild() {\n  make\n}\n', 'shell')).toEqual([
      null,
      'function build',
    ]);
  });

  it('returns one section without symbol for JSON and unknown languages', () => {
    expect(sections('{\n  "a": 1\n}\n', 'json')).toEqual([{ symbol: null, text: '{\n  "a": 1\n}\n' }]);
    expect(splitCodeSections('class A {}\n', undefined)).toHaveLength(1);
    expect(splitCodeSections('', 'typescript')).toEqual([{ start: 0, end: 0, symbol: null }]);
  });

  it('truncates very long symbols', () => {
    const selector = `.${'a'.repeat(200)}`;
    const symbol = sections(`${selector} {\n}\n`, 'css')[0]?.symbol ?? '';
    expect(Array.from(symbol)).toHaveLength(80);
    expect(symbol.endsWith('…')).toBe(true);
  });
});
