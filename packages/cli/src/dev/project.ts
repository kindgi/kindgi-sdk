// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The project `kindgi dev` runs in, and what it gets from it: one database
 * in the bundled Postgres, and one dev tenant and user, for every pack of
 * the project.
 *
 * - **The name:** `project` in the Kindgi config (`kindgi.config.ts`, or
 *   `[tool.kindgi]` in `pyproject.toml`); else the git repository's name
 *   (its main checkout's folder, the same in every worktree); else the
 *   nearest workspace root's folder; else the pack's folder.
 * - **A linked git worktree** gets a database of its own,
 *   `kindgi_<project>__<worktree>`, named after git's own (unique) name for
 *   the worktree: branches on different Kindgi versions usually live in
 *   worktrees, and must not share a schema. The main checkout has
 *   `kindgi_<project>`.
 * - **The tenant and user** derive from the database's name, so every pack
 *   of the project, and every restart, get the same ones.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** Where the project's name came from. */
export type ProjectNameSource = 'config' | 'repository' | 'workspace' | 'pack folder';

export interface DevProject {
  /** The project's name, as given or found. */
  readonly name: string;
  readonly nameFrom: ProjectNameSource;
  /** This checkout's root: the worktree's, or the repository's, or the workspace's, or the pack's. */
  readonly root: string;
  /** In a linked git worktree: git's name for it. */
  readonly worktree?: string;
  /** The database in the bundled Postgres. */
  readonly database: string;
  /** The dev tenant every pack of this project (and worktree) shares. */
  readonly tenantId: string;
  /** The dev user the tenant's token resolves to. */
  readonly userId: string;
}

/** What `git rev-parse` says about a folder: `undefined` outside a repository. */
export interface GitLocation {
  readonly toplevel: string;
  readonly gitDir: string;
  readonly commonDir: string;
}

export type GitLocator = (dir: string) => Promise<GitLocation | undefined>;

/** Postgres's identifier limit, in bytes. */
const MAX_IDENTIFIER = 63;

/** The namespace of the dev tenants' and users' UUIDs (v5). Never change it. */
const DEV_NAMESPACE = '7a1c5e2e-4b8f-5d6a-9c3e-1f0b2d4e6a8c';

export type ProjectOutcome =
  | { readonly kind: 'ok'; readonly project: DevProject }
  | { readonly kind: 'invalid'; readonly message: string };

/**
 * Resolve the project for a pack at `packDir`. `configured` is the
 * config's `project` value, as loaded (validated here).
 */
export async function resolveDevProject(input: {
  readonly packDir: string;
  readonly configured: unknown;
  readonly git?: GitLocator;
}): Promise<ProjectOutcome> {
  const packDir = resolve(input.packDir);
  const configured = input.configured;
  if (configured !== undefined && !isProjectName(configured)) {
    return {
      kind: 'invalid',
      message:
        '`project` in the Kindgi config must be a name with at least one letter or digit, e.g. "acme-app".',
    };
  }
  const git = await (input.git ?? locateGit)(packDir);
  // A workspace root above the pack. The pack's own folder is no workspace
  // of its own: `kindgi init` gives a pack its own pnpm-workspace.yaml.
  const found = git === undefined ? findWorkspaceRoot(packDir) : undefined;
  const workspace = found !== undefined && found !== packDir ? found : undefined;
  const worktree = git !== undefined && linkedWorktree(git) ? basename(git.gitDir) : undefined;

  let name: string;
  let nameFrom: ProjectNameSource;
  if (configured !== undefined) {
    name = configured;
    nameFrom = 'config';
  } else if (git !== undefined) {
    name = repositoryName(git);
    nameFrom = 'repository';
  } else if (workspace !== undefined) {
    name = basename(workspace);
    nameFrom = 'workspace';
  } else {
    name = basename(packDir);
    nameFrom = 'pack folder';
  }
  const root = git?.toplevel ?? workspace ?? packDir;
  const database = projectDatabaseName(name, worktree);
  return {
    kind: 'ok',
    project: {
      name,
      nameFrom,
      root,
      ...(worktree !== undefined && { worktree }),
      database,
      tenantId: uuidV5(`tenant:${database}`),
      userId: uuidV5(`user:${database}`),
    },
  };
}

/** A usable `project` value: a string with a letter or digit in it. */
function isProjectName(value: unknown): value is string {
  return typeof value === 'string' && slug(value) !== '';
}

/**
 * The database's name: `kindgi_<project>`, plus `__<worktree>` in a linked
 * worktree, in Postgres's plain-identifier characters. A name past 63
 * bytes keeps its start and ends with a hash of the whole.
 */
export function projectDatabaseName(project: string, worktree?: string): string {
  const full = `kindgi_${slug(project) || 'project'}${worktree === undefined ? '' : `__${slug(worktree) || 'worktree'}`}`;
  if (full.length <= MAX_IDENTIFIER) return full;
  const hash = createHash('sha256').update(full).digest('hex').slice(0, 8);
  return `${full.slice(0, MAX_IDENTIFIER - hash.length - 1).replace(/_+$/, '')}_${hash}`;
}

/** Lowercase letters, digits and single underscores: each other run becomes one `_`. */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** A linked worktree: its git dir isn't the repository's common one. */
function linkedWorktree(git: GitLocation): boolean {
  return resolve(git.gitDir) !== resolve(git.commonDir);
}

/** The repository's name: its main checkout's folder (`<root>/.git`), or a bare repository's. */
function repositoryName(git: GitLocation): string {
  const common = resolve(git.commonDir);
  if (basename(common) === '.git') return basename(dirname(common));
  return basename(common).replace(/\.git$/, '') || basename(git.toplevel);
}

/**
 * The nearest folder at or above `dir` that roots a workspace: a
 * `pnpm-workspace.yaml`, a `package.json` with `workspaces`, or a
 * `pyproject.toml` with a uv workspace.
 */
export function findWorkspaceRoot(dir: string): string | undefined {
  let current = resolve(dir);
  for (;;) {
    if (isWorkspaceRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function isWorkspaceRoot(dir: string): boolean {
  if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return true;
  const pkg = readIfExists(join(dir, 'package.json'));
  if (pkg !== undefined) {
    try {
      if ((JSON.parse(pkg) as { workspaces?: unknown }).workspaces !== undefined) return true;
    } catch {
      // Not JSON: not a workspace root.
    }
  }
  const pyproject = readIfExists(join(dir, 'pyproject.toml'));
  return pyproject !== undefined && /^\s*\[tool\.uv\.workspace\]/m.test(pyproject);
}

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** `git rev-parse` for `dir`, with absolute paths; `undefined` outside a repository or without git. */
export const locateGit: GitLocator = (dir) =>
  new Promise((resolvePromise) => {
    execFile(
      'git',
      ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'],
      { cwd: dir, timeout: 5000 },
      (err, stdout) => {
        if (err !== null) {
          resolvePromise(undefined);
          return;
        }
        const [toplevel, gitDir, commonDir] = stdout.trim().split('\n');
        resolvePromise(
          toplevel !== undefined && gitDir !== undefined && commonDir !== undefined
            ? { toplevel, gitDir, commonDir }
            : undefined,
        );
      },
    );
  });

/** A name-based UUID (RFC 9562 version 5, SHA-1) in the dev namespace. */
export function uuidV5(name: string): string {
  return uuidV5In(DEV_NAMESPACE, name);
}

/** A name-based UUID (RFC 9562 version 5, SHA-1) in `namespace`. */
export function uuidV5In(namespace: string, name: string): string {
  const bytes = createHash('sha1')
    .update(
      Buffer.concat([Buffer.from(namespace.replace(/-/g, ''), 'hex'), Buffer.from(name, 'utf8')]),
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
