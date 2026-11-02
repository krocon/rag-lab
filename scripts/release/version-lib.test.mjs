// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compareSemver,
  latestReleasedVersion,
  parseSemver,
  releaseChangelog,
  releaseNotes,
  setPackageVersion,
  unreleasedBody,
} from './version-lib.mjs';

describe('parseSemver', () => {
  it('accepts x.y.z and pre-releases', () => {
    assert.deepEqual(parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] });
    assert.deepEqual(parseSemver('0.2.0-rc.1').prerelease, ['rc', '1']);
  });

  for (const invalid of ['1.2', 'v1.2.3', '01.2.3', '1.2.3-', '1.2.3+build', '1.2.3-01', '']) {
    it(`rejects "${invalid}"`, () => {
      assert.throws(() => parseSemver(invalid), /not a valid version/);
    });
  }
});

describe('compareSemver', () => {
  const ordered = [
    '0.1.0',
    '0.1.1',
    '0.2.0-alpha',
    '0.2.0-alpha.1',
    '0.2.0-alpha.beta',
    '0.2.0-beta.2',
    '0.2.0-beta.11',
    '0.2.0-rc.1',
    '0.2.0',
    '1.0.0',
    '10.0.0',
  ];
  it('orders by SemVer precedence', () => {
    const shuffled = [...ordered].reverse();
    assert.deepEqual(shuffled.sort(compareSemver), ordered);
  });
  it('treats equal versions as equal', () => {
    assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
  });
});

describe('setPackageVersion', () => {
  const pkg =
    '{\n  "name": "@raglab/api",\n  "version": "0.1.0",\n  "dependencies": {\n    "x": "1.0.0"\n  }\n}\n';

  it('replaces only the top-level version and keeps the formatting', () => {
    const updated = setPackageVersion(pkg, '0.2.0');
    assert.equal(updated, pkg.replace('"version": "0.1.0"', '"version": "0.2.0"'));
  });

  it('fails without a version field', () => {
    assert.throws(() => setPackageVersion('{\n  "name": "x"\n}\n', '1.0.0'), /no "version"/);
  });

  it('does not touch a nested "version" key', () => {
    const nested =
      '{\n  "name": "x",\n  "version": "1.0.0",\n  "engines": {\n    "version": "keep"\n  }\n}\n';
    assert.match(setPackageVersion(nested, '2.0.0'), /"version": "keep"/);
  });
});

const changelog = `# Changelog

Intro text.

## [Unreleased]

### Added

- Feature A.

[Unreleased]: https://github.com/example/project/commits/main
`;

describe('releaseChangelog', () => {
  it('moves Unreleased into a dated version section and links the tag (first release)', () => {
    const result = releaseChangelog(changelog, '0.1.0', '2026-11-02');
    assert.equal(
      result,
      `# Changelog

Intro text.

## [Unreleased]

## [0.1.0] - 2026-11-02

### Added

- Feature A.

[Unreleased]: https://github.com/example/project/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/example/project/releases/tag/v0.1.0
`,
    );
  });

  it('links a comparison with the previous release', () => {
    const first = releaseChangelog(changelog, '0.1.0', '2026-11-02');
    const withChange = first.replace(
      '## [Unreleased]\n',
      '## [Unreleased]\n\n### Fixed\n\n- Bug B.\n',
    );
    const second = releaseChangelog(withChange, '0.2.0', '2026-12-01');
    assert.match(
      second,
      /## \[Unreleased\]\n\n## \[0\.2\.0\] - 2026-12-01\n\n### Fixed\n\n- Bug B\.\n\n## \[0\.1\.0\]/,
    );
    assert.match(
      second,
      /\[Unreleased\]: https:\/\/github\.com\/example\/project\/compare\/v0\.2\.0\.\.\.HEAD\n\[0\.2\.0\]: https:\/\/github\.com\/example\/project\/compare\/v0\.1\.0\.\.\.v0\.2\.0\n\[0\.1\.0\]: /,
    );
    assert.equal(latestReleasedVersion(second), '0.2.0');
  });

  it('refuses an empty Unreleased section', () => {
    const empty = releaseChangelog(changelog, '0.1.0', '2026-11-02');
    assert.throws(() => releaseChangelog(empty, '0.2.0', '2026-12-01'), /is empty/);
  });

  it('refuses a version that already has a section', () => {
    const released = releaseChangelog(changelog, '0.1.0', '2026-11-02').replace(
      '## [Unreleased]\n',
      '## [Unreleased]\n\n- x\n',
    );
    assert.throws(() => releaseChangelog(released, '0.1.0', '2026-11-03'), /already has a section/);
  });

  it('refuses invalid dates and missing links', () => {
    assert.throws(() => releaseChangelog(changelog, '0.1.0', '02.11.2026'), /invalid date/);
    assert.throws(
      () => releaseChangelog(changelog.replace(/\[Unreleased\]: .*\n/, ''), '0.1.0', '2026-11-02'),
      /link line/,
    );
  });
});

describe('releaseNotes / unreleasedBody', () => {
  it('returns the section body without heading and links', () => {
    assert.equal(unreleasedBody(changelog), '### Added\n\n- Feature A.');
    const released = releaseChangelog(changelog, '0.1.0', '2026-11-02');
    assert.equal(releaseNotes(released, '0.1.0'), '### Added\n\n- Feature A.');
  });

  it('fails for an unknown version', () => {
    assert.throws(() => releaseNotes(changelog, '9.9.9'), /no section for 9\.9\.9/);
  });
});
