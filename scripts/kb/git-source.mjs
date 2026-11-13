// @ts-check
/**
 * Git access of `pnpm kb:import`: URL checks, removing credentials, a shallow clone into a
 * temporary directory and reading a local work tree (`git ls-files`). Uses the locally installed
 * `git` with the user's own credentials (credential helper, SSH agent) – RAGLab never sees them.
 *
 * Safety measures of the clone (docs/security.md §13):
 * - only `https://`, `ssh://` and `git@host:path` (no `file://`, `ext::`, local paths – except in
 *   tests with `allowFileUrls`),
 * - no hooks (`core.hooksPath=/dev/null`, empty template directory), no submodules, no Git LFS
 *   downloads (`GIT_LFS_SKIP_SMUDGE=1`), no tags, depth 1,
 * - the temporary directory is removed in every case,
 * - URLs are only shown and stored without credentials; Git's error output is redacted.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** An error with a message meant for the user (no stack trace needed). */
export class GitSourceError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'GitSourceError';
  }
}

/** scp-like address `user@host:path` (no scheme). */
const SCP_LIKE = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(?!\/\/)(.+)$/;

/** Branch, tag or commit names accepted by `--ref`. */
const SAFE_REF = /^(?!-)[A-Za-z0-9._/@+-]{1,255}$/;

/** Full SHA-1 or SHA-256 commit id. */
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * True if `value` looks like a Git URL rather than a local directory.
 * @param {string} value
 */
export function isGitUrl(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || SCP_LIKE.test(value);
}

/**
 * Validates a Git URL for cloning. Returns the URL to clone (unchanged, possibly with
 * credentials) and the display form without them.
 * @param {string} value
 * @param {{ allowFileUrls?: boolean }} [options]
 * @returns {{ cloneUrl: string, displayUrl: string }}
 */
export function parseGitUrl(value, options = {}) {
  const url = value.trim();
  if (url.startsWith('-')) {
    throw new GitSourceError('Invalid Git URL: it must not start with "-".');
  }
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point here
  if (/[\u0000- \u007F]/.test(url)) {
    throw new GitSourceError('Invalid Git URL: it must not contain whitespace or control characters.');
  }
  if (SCP_LIKE.test(url)) {
    return { cloneUrl: url, displayUrl: url };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new GitSourceError('Invalid Git URL: expected https://…, ssh://… or git@host:path.');
  }
  const allowed = ['https:', 'ssh:', ...(options.allowFileUrls ? ['file:'] : [])];
  if (!allowed.includes(parsed.protocol)) {
    throw new GitSourceError(
      `Unsupported Git URL scheme "${parsed.protocol}" – use https://, ssh:// or git@host:path.`,
    );
  }
  return { cloneUrl: url, displayUrl: stripCredentials(url) };
}

/**
 * Removes user name and password/token from a URL (`https://user:token@host/x` →
 * `https://host/x`). The SSH user of `ssh://git@host` and `git@host:path` is kept – it is no
 * secret. Query and fragment are removed as well.
 * @param {string} url
 */
export function stripCredentials(url) {
  if (SCP_LIKE.test(url)) {
    return url;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'ssh:') {
      parsed.password = '';
    } else {
      parsed.username = '';
      parsed.password = '';
    }
    parsed.search = '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return url.replace(/\/\/[^/@\s]*@/, '//');
  }
}

/**
 * Replaces credentials in any URL inside a text (Git error output) with `***`.
 * @param {string} text
 */
export function redactCredentials(text) {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1***@');
}

/**
 * @param {string} ref
 */
export function validateRef(ref) {
  if (!SAFE_REF.test(ref) || ref.includes('..')) {
    throw new GitSourceError(`Invalid --ref "${ref}": use a branch, tag or commit name.`);
  }
  return ref;
}

/**
 * Runs git and returns stdout. Errors carry git's (redacted) stderr.
 * @typedef {(args: string[], options?: { cwd?: string, env?: NodeJS.ProcessEnv, maxBuffer?: number }) => Promise<string>} GitRunner
 * @type {GitRunner}
 */
export const runGit = (args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = /** @type {NodeJS.ErrnoException} */ (error).code;
          if (code === 'ENOENT') {
            reject(new GitSourceError('git is not installed or not on the PATH.'));
            return;
          }
          const detail = redactCredentials(String(stderr || error.message).trim()).slice(0, 800);
          reject(new GitSourceError(`git ${args[0] ?? ''} failed: ${detail}`));
          return;
        }
        resolve(stdout);
      },
    );
  });

/** Options that keep repository content from running anything during clone and checkout. */
const SAFE_CONFIG = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'init.templateDir=',
  '-c', 'protocol.ext.allow=never',
  '-c', 'submodule.recurse=false',
  '-c', 'core.fsmonitor=false',
  '-c', 'advice.detachedHead=false',
];

/**
 * Shallow clone of `ref` (default branch without `ref`) into a new temporary directory.
 * Branches, tags and full commit SHAs work (`git fetch --depth 1 origin <ref>`).
 * Call `cleanup()` in every case (it is also called when cloning fails).
 *
 * @param {string} url as entered (may contain credentials; never printed)
 * @param {{ ref?: string, allowFileUrls?: boolean, git?: GitRunner, tempRoot?: string }} [options]
 * @returns {Promise<{ directory: string, commit: string, ref: string | null, displayUrl: string, cleanup: () => Promise<void> }>}
 */
export async function cloneShallow(url, options = {}) {
  const { git = runGit, tempRoot = tmpdir() } = options;
  const { cloneUrl, displayUrl } = parseGitUrl(url, options);
  const ref = options.ref === undefined ? undefined : validateRef(options.ref);
  const directory = await mkdtemp(join(tempRoot, 'raglab-import-'));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  const env = { GIT_LFS_SKIP_SMUDGE: '1' };
  const config = [
    ...SAFE_CONFIG,
    '-c',
    `protocol.file.allow=${options.allowFileUrls ? 'always' : 'never'}`,
  ];
  try {
    await git([...config, 'init', '--quiet', directory], { env });
    await git([...config, 'remote', 'add', 'origin', '--', cloneUrl], { cwd: directory, env });
    await git(
      [
        ...config,
        'fetch',
        '--quiet',
        '--depth',
        '1',
        '--no-tags',
        '--no-recurse-submodules',
        'origin',
        '--',
        ref ?? 'HEAD',
      ],
      { cwd: directory, env },
    );
    await git([...config, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], { cwd: directory, env });
    const commit = (await git(['rev-parse', 'HEAD'], { cwd: directory })).trim();
    return { directory: await realpath(directory), commit, ref: ref ?? null, displayUrl, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * Information about a local directory inside a Git work tree, or `undefined` outside of one:
 * the files Git sees there (tracked plus untracked-but-not-ignored, so every `.gitignore` and
 * `.git/info/exclude` apply), the commit, the branch and the `origin` URL without credentials.
 *
 * @param {string} directory
 * @param {{ git?: GitRunner }} [options]
 * @returns {Promise<{ files: string[], commit: string | null, ref: string | null, url: string | null, clean: boolean } | undefined>}
 */
export async function readWorkTree(directory, options = {}) {
  const { git = runGit } = options;
  try {
    const inside = (await git(['rev-parse', '--is-inside-work-tree'], { cwd: directory })).trim();
    if (inside !== 'true') return undefined;
  } catch {
    return undefined;
  }
  const output = await git(
    ['-c', 'core.quotePath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: directory },
  );
  const files = output.split('\0').filter((path) => path !== '');
  const optional = async (/** @type {string[]} */ args) => {
    try {
      return (await git(args, { cwd: directory })).trim() || null;
    } catch {
      return null;
    }
  };
  const commit = await optional(['rev-parse', 'HEAD']);
  const branch = await optional(['symbolic-ref', '--short', '-q', 'HEAD']);
  const remote = await optional(['remote', 'get-url', 'origin']);
  const status = await optional(['status', '--porcelain', '--untracked-files=no']);
  return {
    files: [...new Set(files)],
    commit: commit !== null && COMMIT_SHA.test(commit) ? commit : null,
    ref: branch,
    url: remote === null ? null : sourceUrlForStorage(remote),
    clean: status === null,
  };
}

/**
 * The form of a remote URL that may be stored and shown: credentials removed; local paths and
 * `file://` URLs (no repository host to link to) become `null`.
 * @param {string} url
 */
export function sourceUrlForStorage(url) {
  if (SCP_LIKE.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') return null;
    return stripCredentials(url);
  } catch {
    return null;
  }
}
