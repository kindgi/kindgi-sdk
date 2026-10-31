// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Where the pack lives in git, as `kindgi deploy` says it on
 * `POST /v1/deployments` (`source`). The runtime keeps it on the
 * deployment, with each block's file from the image's index, so a block
 * change pinned later can be opened as a pull request against that
 * commit.
 *
 * Nothing local leaves the machine: `repo` is a host and a path with no
 * user, password or token, and `path` is relative to the repository's
 * root. Outside a work tree, or before its first commit, there's no
 * `source`.
 */

import { execFile } from 'node:child_process';

export interface DeploySource {
  /**
   * The `origin` remote as `host/owner/name` (a group path may stand for
   * the owner). Absent when there's no `origin`, or it isn't a host and a
   * path (a local folder, say).
   */
  readonly repo?: string;
  /** The pack's folder relative to the repository's root, `/`-separated: `.` at the root. */
  readonly path: string;
  /** The commit checked out (`HEAD`), its full hex id. */
  readonly commit: string;
  /** The branch checked out; absent on a detached `HEAD`. */
  readonly branch?: string;
  /** The pack's folder has changes the commit doesn't hold, untracked files included. */
  readonly dirty: boolean;
}

/** `git <args>` run in `cwd`: what it printed, or `undefined` when it failed or there's no git. */
export type GitRunner = (cwd: string, args: readonly string[]) => Promise<string | undefined>;

export const runGit: GitRunner = (cwd, args) =>
  new Promise((resolvePromise) => {
    execFile(
      'git',
      [...args],
      { cwd, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolvePromise(err === null ? stdout : undefined),
    );
  });

const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;
/** The longest `repo`, `path` and `branch` the runtime takes. */
const TEXT_MAX = 1024;
const BRANCH_MAX = 255;
const REMOTE_PROTOCOLS = new Set(['https:', 'http:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:']);

/** Where the pack at `packDir` lives in git; `undefined` outside a work tree or before its first commit. */
export async function readDeploySource(
  packDir: string,
  git: GitRunner = runGit,
): Promise<DeploySource | undefined> {
  const [inside, prefix] = (
    (await git(packDir, ['rev-parse', '--is-inside-work-tree', '--show-prefix'])) ?? ''
  ).split('\n');
  if (inside !== 'true' || prefix === undefined) return undefined;
  const path = prefix.replace(/\/$/, '') || '.';
  if (path !== '.' && !isRelativePath(path)) return undefined;

  const commit = (
    await git(packDir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  )?.trim();
  if (commit === undefined || !COMMIT_RE.test(commit)) return undefined;

  // Read-only: no index refresh, so a deploy never takes the repository's lock.
  const status = await git(packDir, [
    '--no-optional-locks',
    'status',
    '--porcelain',
    '--untracked-files=normal',
    '--',
    '.',
  ]);
  if (status === undefined) return undefined;

  const branch = (await git(packDir, ['symbolic-ref', '--quiet', '--short', 'HEAD']))?.trim();
  const remote = (await git(packDir, ['remote', 'get-url', 'origin']))?.trim();
  const repo = remote === undefined || remote === '' ? undefined : repoOf(remote);
  return {
    ...(repo !== undefined && { repo }),
    path,
    commit,
    ...(branch !== undefined && branch !== '' && branch.length <= BRANCH_MAX && { branch }),
    dirty: status.trim() !== '',
  };
}

/**
 * A remote's URL as `host/owner/name`: no scheme, user, password, token,
 * port or `.git`. `git@github.com:acme/pack.git` and
 * `https://x-access-token:…@github.com/acme/pack` are both
 * `github.com/acme/pack`. `undefined` for a local folder, a `file:` URL,
 * or one that isn't a host and at least two path parts.
 */
export function repoOf(url: string): string | undefined {
  let host: string;
  let path: string;
  // scp-like `[user@]host:path`, which has no scheme.
  const scp = url.includes('://') ? null : /^(?:[^@/:]+@)?([^@/:]+):(.+)$/.exec(url);
  if (scp !== null) {
    host = scp[1] as string;
    path = scp[2] as string;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    if (!REMOTE_PROTOCOLS.has(parsed.protocol)) return undefined;
    host = parsed.hostname;
    path = parsed.pathname;
  }
  host = host.toLowerCase();
  const segments = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split('/');
  if (
    !HOST_RE.test(host) ||
    segments.length < 2 ||
    segments.some((s) => !SEGMENT_RE.test(s) || s === '.' || s === '..')
  ) {
    return undefined;
  }
  const repo = `${host}/${segments.join('/')}`;
  return repo.length <= TEXT_MAX ? repo : undefined;
}

/** A `/`-separated path inside a folder, as the runtime takes one. */
function isRelativePath(value: string): boolean {
  if (value.length > TEXT_MAX || value.includes('\\')) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return value.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}
