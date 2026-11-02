#!/usr/bin/env node
// @ts-check
/**
 * Release versioning for RAGLab (docs/release.md). All packages share one version.
 *
 *   pnpm release:version <x.y.z> [--dry-run] [--date YYYY-MM-DD]
 *       Sets <x.y.z> in the root package.json and every workspace package (apps/*, packages/*) and
 *       moves the "Unreleased" entries of CHANGELOG.md into a "## [x.y.z] - date" section.
 *       --dry-run prints what would change and writes nothing.
 *   node scripts/release-version.mjs --check <x.y.z>
 *       Exits 1 unless every package has <x.y.z> and CHANGELOG.md has a section for it
 *       (used by .github/workflows/release.yml for the pushed tag).
 *   node scripts/release-version.mjs --notes <x.y.z>
 *       Prints the CHANGELOG.md section of <x.y.z> (GitHub release notes).
 *
 * The API (apps/api/src/version.ts) and the MCP server (apps/mcp/src/server.ts) read their
 * version from their package.json at runtime, so there is no other place to update.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  compareSemver,
  parseSemver,
  releaseChangelog,
  releaseNotes,
  setPackageVersion,
} from './release/version-lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const changelogPath = join(root, 'CHANGELOG.md');

/** Root package.json and the package.json of every workspace package (pnpm-workspace.yaml). */
function packageFiles() {
  const files = [join(root, 'package.json')];
  for (const dir of ['apps', 'packages']) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const file = join(root, dir, entry.name, 'package.json');
      if (entry.isDirectory() && existsSync(file)) files.push(file);
    }
  }
  return files;
}

/** @param {string} file */
const readVersion = (file) =>
  /** @type {{ version: string }} */ (JSON.parse(readFileSync(file, 'utf8'))).version;

/** @param {string} file */
const rel = (file) => relative(root, file);

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      notes: { type: 'boolean', default: false },
      date: { type: 'string' },
    },
  });
  const version = positionals[0]?.replace(/^v/, '');
  if (!version || positionals.length !== 1) {
    throw new Error(
      'usage: pnpm release:version <x.y.z> [--dry-run] [--date YYYY-MM-DD] | --check <x.y.z> | --notes <x.y.z>',
    );
  }
  parseSemver(version);
  const changelog = readFileSync(changelogPath, 'utf8');

  if (values.notes) {
    process.stdout.write(`${releaseNotes(changelog, version)}\n`);
    return;
  }

  if (values.check) {
    const problems = packageFiles()
      .filter((file) => readVersion(file) !== version)
      .map((file) => `${rel(file)} has version ${readVersion(file)}, expected ${version}`);
    try {
      releaseNotes(changelog, version);
    } catch (error) {
      problems.push(/** @type {Error} */ (error).message);
    }
    if (problems.length > 0) {
      throw new Error(`release check failed:\n  - ${problems.join('\n  - ')}`);
    }
    console.log(`Version ${version} is consistent (packages and CHANGELOG.md).`);
    return;
  }

  const files = packageFiles();
  const current = readVersion(files[0] ?? '');
  const mismatched = files.filter((file) => readVersion(file) !== current);
  if (mismatched.length > 0) {
    throw new Error(
      `package versions differ from the root (${current}): ${mismatched.map(rel).join(', ')}`,
    );
  }
  // Equal is allowed once: the first release publishes the version the packages already have.
  if (compareSemver(version, current) < 0) {
    throw new Error(`${version} is lower than the current version ${current}`);
  }
  const date = values.date ?? new Date().toISOString().slice(0, 10);
  const nextChangelog = releaseChangelog(changelog, version, date);
  const updates = files.map((file) => ({
    file,
    text: setPackageVersion(readFileSync(file, 'utf8'), version),
  }));

  const prefix = values['dry-run'] ? '[dry run] would update' : 'updated';
  for (const { file, text } of updates) {
    if (!values['dry-run']) writeFileSync(file, text);
    console.log(`${prefix} ${rel(file)}: ${current} → ${version}`);
  }
  if (!values['dry-run']) writeFileSync(changelogPath, nextChangelog);
  console.log(`${prefix} CHANGELOG.md: "Unreleased" → "[${version}] - ${date}"`);
  if (values['dry-run']) {
    console.log('\nRelease notes:\n');
    console.log(releaseNotes(nextChangelog, version));
  } else {
    console.log(
      `\nNext: review the diff, commit "chore(release): v${version}", then tag v${version} (docs/release.md).`,
    );
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
