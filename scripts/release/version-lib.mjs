// @ts-check
/**
 * Pure helpers of the release script (scripts/release-version.mjs): SemVer parsing, version
 * updates in package.json text and the Keep-a-Changelog transformation. No file system access,
 * so everything here is unit-tested (version-lib.test.mjs).
 */

/** SemVer 2.0.0 without build metadata: MAJOR.MINOR.PATCH with an optional pre-release. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

/**
 * @typedef {{ major: number, minor: number, patch: number, prerelease: string[] }} SemVer
 */

/**
 * @param {string} version
 * @returns {SemVer}
 */
export function parseSemver(version) {
  const match = SEMVER.exec(version);
  if (!match) {
    throw new Error(
      `"${version}" is not a valid version (expected x.y.z or x.y.z-pre, e.g. 1.2.0)`,
    );
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/**
 * Compares two versions by SemVer precedence.
 * @param {string} a
 * @param {string} b
 * @returns {number} negative if a < b, 0 if equal, positive if a > b
 */
export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  for (const key of /** @type {const} */ (['major', 'minor', 'patch'])) {
    if (x[key] !== y[key]) return x[key] - y[key];
  }
  // A version without pre-release ranks higher than the same version with one.
  if (x.prerelease.length === 0 || y.prerelease.length === 0) {
    return y.prerelease.length - x.prerelease.length;
  }
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    const p = x.prerelease[i];
    const q = y.prerelease[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pNum = /^\d+$/.test(p);
    const qNum = /^\d+$/.test(q);
    if (pNum && qNum) return Number(p) - Number(q);
    if (pNum) return -1;
    if (qNum) return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * Replaces the top-level "version" of a package.json text and keeps its formatting.
 * @param {string} text package.json content
 * @param {string} version new version
 * @returns {string}
 */
export function setPackageVersion(text, version) {
  /** @type {{ version?: unknown }} */
  const json = JSON.parse(text);
  if (typeof json.version !== 'string') {
    throw new Error('package.json has no "version" field');
  }
  // The first "version" key at indentation level one is the top-level field (2-space format).
  const pattern = /^( {2}"version": )"[^"]*"/m;
  if (!pattern.test(text)) {
    throw new Error('package.json "version" is not formatted as expected (2-space indentation)');
  }
  const updated = text.replace(pattern, `$1"${version}"`);
  if (JSON.parse(updated).version !== version) {
    throw new Error('updating "version" in package.json failed');
  }
  return updated;
}

const UNRELEASED_HEADING = /^## \[Unreleased\][^\n]*\n/m;
const SECTION_HEADING = /^## \[/m;
const UNRELEASED_LINK = /^\[Unreleased\]: (https:\/\/github\.com\/[^/\s]+\/[^/\s]+)\/\S*$/m;

/**
 * Body of the "## [Unreleased]" section (without heading), trimmed.
 * @param {string} changelog
 */
export function unreleasedBody(changelog) {
  const heading = UNRELEASED_HEADING.exec(changelog);
  if (!heading) throw new Error('CHANGELOG.md has no "## [Unreleased]" section');
  const start = heading.index + heading[0].length;
  const rest = changelog.slice(start);
  const next = SECTION_HEADING.exec(rest);
  const linksStart = /^\[[^\]]+\]: /m.exec(rest);
  const end = Math.min(next?.index ?? rest.length, linksStart?.index ?? rest.length);
  return rest.slice(0, end).trim();
}

/**
 * Moves the "Unreleased" entries into a new "## [version] - date" section, leaves an empty
 * "Unreleased" section and updates the comparison links at the end of the file.
 * @param {string} changelog CHANGELOG.md content (Keep a Changelog 1.1.0)
 * @param {string} version new version without "v"
 * @param {string} date release date (YYYY-MM-DD)
 * @returns {string}
 */
export function releaseChangelog(changelog, version, date) {
  parseSemver(version);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid date "${date}" (YYYY-MM-DD)`);
  if (changelog.includes(`## [${version}]`)) {
    throw new Error(`CHANGELOG.md already has a section for ${version}`);
  }
  const body = unreleasedBody(changelog);
  if (body === '') {
    throw new Error(
      'the "Unreleased" section of CHANGELOG.md is empty – describe the changes first',
    );
  }
  const link = UNRELEASED_LINK.exec(changelog);
  if (!link) {
    throw new Error(
      'CHANGELOG.md needs a link line "[Unreleased]: https://github.com/<owner>/<repo>/…" at the end',
    );
  }
  const repoUrl = link[1];
  const previous = latestReleasedVersion(changelog);

  const heading = /** @type {RegExpExecArray} */ (UNRELEASED_HEADING.exec(changelog));
  const before = changelog.slice(0, heading.index);
  const afterHeading = changelog.slice(heading.index + heading[0].length);
  const bodyStart = afterHeading.indexOf(body);
  const afterBody = afterHeading.slice(bodyStart + body.length);

  let result = `${before}## [Unreleased]\n\n## [${version}] - ${date}\n\n${body}\n\n${afterBody.replace(/^\n+/, '')}`;
  const versionLink = previous
    ? `[${version}]: ${repoUrl}/compare/v${previous}...v${version}`
    : `[${version}]: ${repoUrl}/releases/tag/v${version}`;
  result = result.replace(
    UNRELEASED_LINK,
    `[Unreleased]: ${repoUrl}/compare/v${version}...HEAD\n${versionLink}`,
  );
  return result;
}

/**
 * Newest version that has a "## [x.y.z]" section, or undefined.
 * @param {string} changelog
 */
export function latestReleasedVersion(changelog) {
  const versions = [...changelog.matchAll(/^## \[(\d[^\]]*)\]/gm)].map(
    (m) => /** @type {string} */ (m[1]),
  );
  return versions.sort(compareSemver).at(-1);
}

/**
 * Release notes of one version: the body of its "## [version]" section.
 * @param {string} changelog
 * @param {string} version
 */
export function releaseNotes(changelog, version) {
  const heading = new RegExp(
    `^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][^\\n]*\\n`,
    'm',
  ).exec(changelog);
  if (!heading) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const rest = changelog.slice(heading.index + heading[0].length);
  const next = SECTION_HEADING.exec(rest);
  const linksStart = /^\[[^\]]+\]: /m.exec(rest);
  const end = Math.min(next?.index ?? rest.length, linksStart?.index ?? rest.length);
  const notes = rest.slice(0, end).trim();
  if (notes === '') throw new Error(`the section for ${version} in CHANGELOG.md is empty`);
  return notes;
}
