import type { CollectionSource, SetCollectionSourceRequest } from '@raglab/shared';
import { badRequest } from '../../http/errors.js';
import type { CollectionSourceRecord } from '../../db/schema.js';

/** Maximum lengths of the stored source fields (characters). */
export const MAX_SOURCE_URL_LENGTH = 2048;
export const MAX_SOURCE_REF_LENGTH = 255;

/** Full SHA-1 (40) or SHA-256 (64) commit id in lower case. */
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** scp-like SSH address `user@host:path` (no scheme); the user must not carry a password. */
const SCP_LIKE = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(?!\/\/)(.+)$/;

/** Branch/tag names: printable ASCII without spaces, `~^:?*[\` and control characters. */
const SAFE_REF = /^[A-Za-z0-9._/@+-]+$/;

const invalidSource = (message: string, field: string) =>
  badRequest('INVALID_SOURCE', message, [{ location: `body/${field}`, message }]);

/**
 * Validates a repository URL for storage. Accepted: `https://host/path`, `ssh://[git@]host/path`
 * and `git@host:path`. **Credentials are rejected** (`https://user:token@…`, `https://token@…`,
 * `ssh://user:password@…`): RAGLab must never store, show or log them – `kb:import` removes them
 * before it sends the URL. The value itself is never echoed in the error.
 */
export function validateSourceUrl(raw: string): string {
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_SOURCE_URL_LENGTH) {
    throw invalidSource(
      `url must be 1–${MAX_SOURCE_URL_LENGTH} characters long.`,
      'url',
    );
  }
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point here
  if (/[\u0000- \u007F-\u009F]/.test(value)) {
    throw invalidSource('url must not contain whitespace or control characters.', 'url');
  }
  const scp = SCP_LIKE.exec(value);
  if (scp) {
    return value;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidSource('url must be an https://, ssh:// or git@host:path URL.', 'url');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'ssh:') {
    throw invalidSource('url must use https:// or ssh:// (or git@host:path).', 'url');
  }
  if (url.password !== '' || (url.protocol === 'https:' && url.username !== '')) {
    throw invalidSource(
      'url must not contain credentials (user name, password or token). Remove them before importing.',
      'url',
    );
  }
  if (url.search !== '' || url.hash !== '') {
    throw invalidSource('url must not contain a query or fragment.', 'url');
  }
  return value;
}

/** Validates the import source sent by a client; `importedAt` is set by the server. */
export function toSourceRecord(
  input: SetCollectionSourceRequest,
  importedAt: Date,
): CollectionSourceRecord {
  const url = input.url === undefined || input.url === null ? null : validateSourceUrl(input.url);
  const ref = input.ref === undefined || input.ref === null ? null : input.ref.trim();
  if (ref !== null && (ref.length === 0 || ref.length > MAX_SOURCE_REF_LENGTH || !SAFE_REF.test(ref))) {
    throw invalidSource('ref must be a branch, tag or commit name without special characters.', 'ref');
  }
  const commit = input.commit === undefined || input.commit === null ? null : input.commit.trim().toLowerCase();
  if (commit !== null && !COMMIT_SHA.test(commit)) {
    throw invalidSource('commit must be a full 40- or 64-character hexadecimal commit SHA.', 'commit');
  }
  return { kind: input.kind, url, ref, commit, importedAt: importedAt.toISOString() };
}

export function toCollectionSource(record: CollectionSourceRecord | null): CollectionSource | null {
  return record === null
    ? null
    : {
        kind: record.kind,
        url: record.url,
        ref: record.ref,
        commit: record.commit,
        importedAt: record.importedAt,
      };
}

/** One path segment of an owner/repository name on a known host. */
const NAME_SEGMENT = /^[A-Za-z0-9_.-]+$/;

interface RepositoryLocation {
  host: 'github.com' | 'gitlab.com' | 'bitbucket.org' | 'codeberg.org';
  /** `owner/repo` (GitLab: `group/subgroup/repo`), validated segments, without `.git`. */
  repository: string;
}

const KNOWN_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org']);

/** Host and repository of a stored source URL if it belongs to a known host, else `undefined`. */
export function repositoryLocation(url: string): RepositoryLocation | undefined {
  let host: string;
  let pathname: string;
  const scp = SCP_LIKE.exec(url);
  if (scp) {
    host = (scp[2] ?? '').toLowerCase();
    pathname = scp[3] ?? '';
  } else {
    try {
      const parsed = new URL(url);
      if (parsed.port !== '' && parsed.protocol === 'https:') {
        return undefined;
      }
      host = parsed.hostname.toLowerCase();
      pathname = parsed.pathname;
    } catch {
      return undefined;
    }
  }
  host = host.replace(/^www\./, '');
  if (!KNOWN_HOSTS.has(host)) {
    return undefined;
  }
  const segments = pathname
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/, '')
    .split('/');
  const maxSegments = host === 'gitlab.com' ? 20 : 2;
  if (
    segments.length < 2 ||
    segments.length > maxSegments ||
    !segments.every((segment) => NAME_SEGMENT.test(segment) && segment !== '.' && segment !== '..')
  ) {
    return undefined;
  }
  return { host: host as RepositoryLocation['host'], repository: segments.join('/') };
}

/**
 * Link to `path` (lines `startLine`–`endLine`) at the imported commit, or `null` when it cannot be
 * built safely: unknown host, no commit SHA, no path. Only the validated owner/repository, the
 * hex commit and the percent-encoded path segments go into the URL – nothing a document controls
 * can change scheme, host or the repository.
 */
export function buildSourceUrl(
  source: CollectionSourceRecord | CollectionSource | null,
  path: string | null,
  startLine: number | null,
  endLine: number | null,
): string | null {
  if (source === null || source.url === null || source.commit === null || path === null) {
    return null;
  }
  if (!COMMIT_SHA.test(source.commit)) {
    return null;
  }
  const location = repositoryLocation(source.url);
  if (location === undefined) {
    return null;
  }
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const lines =
    startLine !== null && endLine !== null && startLine >= 1 && endLine >= startLine
      ? { start: startLine, end: endLine }
      : undefined;
  const base = `https://${location.host}/${location.repository}`;
  switch (location.host) {
    case 'github.com':
      return `${base}/blob/${source.commit}/${encodedPath}${lines ? `#L${lines.start}-L${lines.end}` : ''}`;
    case 'gitlab.com':
      return `${base}/-/blob/${source.commit}/${encodedPath}${lines ? `#L${lines.start}-${lines.end}` : ''}`;
    case 'bitbucket.org':
      return `${base}/src/${source.commit}/${encodedPath}${lines ? `#lines-${lines.start}:${lines.end}` : ''}`;
    case 'codeberg.org':
      return `${base}/src/commit/${source.commit}/${encodedPath}${lines ? `#L${lines.start}-L${lines.end}` : ''}`;
  }
}
