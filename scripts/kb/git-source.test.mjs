// @ts-check
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import {
  GitSourceError,
  cloneShallow,
  isGitUrl,
  parseGitUrl,
  readWorkTree,
  redactCredentials,
  sourceUrlForStorage,
  stripCredentials,
  validateRef,
} from './git-source.mjs';

describe('Git URLs', () => {
  it('tells URLs from directories', () => {
    assert.ok(isGitUrl('https://github.com/o/r'));
    assert.ok(isGitUrl('ssh://git@github.com/o/r.git'));
    assert.ok(isGitUrl('git@github.com:o/r.git'));
    assert.ok(!isGitUrl('/Users/me/project'));
    assert.ok(!isGitUrl('./project'));
    assert.ok(!isGitUrl('C:\\project'));
  });

  it('accepts https, ssh and scp-like URLs only', () => {
    assert.deepEqual(parseGitUrl('https://github.com/o/r'), {
      cloneUrl: 'https://github.com/o/r',
      displayUrl: 'https://github.com/o/r',
    });
    assert.equal(parseGitUrl('git@github.com:o/r.git').displayUrl, 'git@github.com:o/r.git');
    for (const url of ['http://github.com/o/r', 'file:///tmp/repo', 'ext::sh -c touch% /tmp/x', 'ftp://x/y']) {
      assert.throws(() => parseGitUrl(url), GitSourceError, url);
    }
    assert.throws(() => parseGitUrl('--upload-pack=touch /tmp/x'), GitSourceError);
    assert.throws(() => parseGitUrl('https://github.com/o/r x'), GitSourceError);
    assert.equal(parseGitUrl('file:///tmp/repo', { allowFileUrls: true }).cloneUrl, 'file:///tmp/repo');
  });

  it('removes credentials for display and storage, never the SSH user', () => {
    const url = 'https://user:ghp_secret@github.com/o/r.git';
    assert.equal(parseGitUrl(url).cloneUrl, url);
    assert.equal(parseGitUrl(url).displayUrl, 'https://github.com/o/r.git');
    assert.equal(stripCredentials('https://token@gitlab.com/g/r'), 'https://gitlab.com/g/r');
    assert.equal(stripCredentials('ssh://git:pw@host/r.git'), 'ssh://git@host/r.git');
    assert.equal(sourceUrlForStorage('https://guiexperttable@github.com/guiexperttable/mono.git'), 'https://github.com/guiexperttable/mono.git');
    assert.equal(sourceUrlForStorage('/local/path/repo'), null);
    assert.equal(sourceUrlForStorage('file:///local/repo'), null);
    assert.equal(
      redactCredentials('fatal: unable to access https://u:secret@github.com/o/r: 403'),
      'fatal: unable to access https://***@github.com/o/r: 403',
    );
  });

  it('validates refs', () => {
    assert.equal(validateRef('main'), 'main');
    assert.equal(validateRef('release/1.2'), 'release/1.2');
    assert.equal(validateRef('a'.repeat(40)), 'a'.repeat(40));
    for (const ref of ['--upload-pack=x', 'a..b', 'with space', '', 'x;rm']) {
      assert.throws(() => validateRef(ref), GitSourceError, ref);
    }
  });
});

const git = (/** @type {string} */ cwd, /** @type {string[]} */ ...args) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

describe('local repositories (no network)', () => {
  /** @type {string} */
  let repo;
  /** @type {string} */
  let tempRoot;
  /** @type {string} */
  let firstCommit;

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), 'raglab-repo-'));
    tempRoot = await mkdtemp(join(tmpdir(), 'raglab-clones-'));
    git(repo, 'init', '--quiet', '--initial-branch=main');
    await writeFile(join(repo, '.gitignore'), 'ignored/\n');
    await mkdir(join(repo, 'src'));
    await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(repo, 'README.md'), '# Repo\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'first');
    firstCommit = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'tag', 'v1');
    await writeFile(join(repo, 'src', 'b.ts'), 'export const b = 2;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'second');
    await mkdir(join(repo, 'ignored'));
    await writeFile(join(repo, 'ignored', 'x.ts'), 'x');
    await writeFile(join(repo, 'untracked.md'), '# New\n');
    git(repo, 'remote', 'add', 'origin', 'https://user:token@github.com/example/repo.git');
  });

  after(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('reads a work tree: tracked and untracked files, commit, branch, remote without credentials', async () => {
    const workTree = await readWorkTree(repo);
    assert.ok(workTree);
    assert.deepEqual([...workTree.files].sort(), ['.gitignore', 'README.md', 'src/a.ts', 'src/b.ts', 'untracked.md']);
    assert.equal(workTree.commit, git(repo, 'rev-parse', 'HEAD'));
    assert.equal(workTree.ref, 'main');
    assert.equal(workTree.url, 'https://github.com/example/repo.git');
    assert.equal(workTree.clean, true);
    assert.equal(await readWorkTree(tempRoot), undefined);
  });

  it('clones the default branch shallowly and cleans up', async () => {
    const clone = await cloneShallow(pathToFileURL(repo).href, { allowFileUrls: true, tempRoot });
    try {
      assert.equal(clone.commit, git(repo, 'rev-parse', 'HEAD'));
      assert.equal(clone.ref, null);
      assert.ok(existsSync(join(clone.directory, 'src', 'b.ts')));
      assert.equal(git(clone.directory, 'rev-list', '--count', 'HEAD'), '1');
    } finally {
      await clone.cleanup();
    }
    assert.ok(!existsSync(clone.directory));
  });

  it('clones a tag and a commit SHA', async () => {
    for (const ref of ['v1', firstCommit]) {
      const clone = await cloneShallow(pathToFileURL(repo).href, { allowFileUrls: true, tempRoot, ref });
      try {
        assert.equal(clone.commit, firstCommit, ref);
        assert.ok(!existsSync(join(clone.directory, 'src', 'b.ts')), ref);
      } finally {
        await clone.cleanup();
      }
    }
  });

  it('removes the temporary directory when cloning fails', async () => {
    await assert.rejects(
      cloneShallow(pathToFileURL(repo).href, { allowFileUrls: true, tempRoot, ref: 'does-not-exist' }),
      GitSourceError,
    );
    assert.deepEqual(await readdir(tempRoot), []);
  });

  it('refuses file URLs unless explicitly allowed (tests only)', async () => {
    await assert.rejects(cloneShallow(pathToFileURL(repo).href, { tempRoot }), GitSourceError);
    assert.deepEqual(await readdir(tempRoot), []);
  });
});
