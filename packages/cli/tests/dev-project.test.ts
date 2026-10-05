// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  type GitLocation,
  findWorkspaceRoot,
  locateGit,
  projectDatabaseName,
  resolveDevProject,
  uuidV5,
  uuidV5In,
} from '../src/dev/project.js';

let root: string;

beforeEach(async () => {
  // realpath: macOS's tmpdir is a symlink, and git prints resolved paths.
  root = await realpath(await mkdtemp(join(tmpdir(), 'kindgi-project-')));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const noGit = async (): Promise<undefined> => undefined;
const gitAt = (location: GitLocation) => async (): Promise<GitLocation> => location;

describe('uuidV5In', () => {
  test("RFC 9562's test vector: www.example.com in the DNS namespace", () => {
    expect(uuidV5In('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });

  test('the dev tenant and user are stable and distinct', () => {
    expect(uuidV5('tenant:kindgi_acme')).toBe(uuidV5('tenant:kindgi_acme'));
    expect(uuidV5('tenant:kindgi_acme')).not.toBe(uuidV5('user:kindgi_acme'));
    expect(uuidV5('tenant:kindgi_acme')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('projectDatabaseName', () => {
  test.each([
    ['acme', undefined, 'kindgi_acme'],
    ['Acme App', undefined, 'kindgi_acme_app'],
    ['acme-app', 'feature/login', 'kindgi_acme_app__feature_login'],
    ['--acme--', undefined, 'kindgi_acme'],
    ['!!!', undefined, 'kindgi_project'],
    ['acme', '...', 'kindgi_acme__worktree'],
  ])('%s (worktree %s) → %s', (project, worktree, name) => {
    expect(projectDatabaseName(project, worktree)).toBe(name);
  });

  test('a name past 63 bytes keeps its start and ends with a hash of the whole', () => {
    const long = projectDatabaseName('acme', 'a'.repeat(80));
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^kindgi_acme__a+_[0-9a-f]{8}$/);
    // Two long names that share their first 54 bytes still differ.
    expect(projectDatabaseName('acme', `${'a'.repeat(80)}x`)).not.toBe(long);
  });
});

describe('resolveDevProject', () => {
  test('`project` in the config wins, and names the database', async () => {
    const outcome = await resolveDevProject({ packDir: root, configured: 'acme-app', git: noGit });
    expect(outcome).toMatchObject({
      kind: 'ok',
      project: { name: 'acme-app', nameFrom: 'config', root, database: 'kindgi_acme_app' },
    });
    if (outcome.kind !== 'ok') return;
    expect(outcome.project.tenantId).toBe(uuidV5('tenant:kindgi_acme_app'));
    expect(outcome.project.userId).toBe(uuidV5('user:kindgi_acme_app'));
    expect(outcome.project.worktree).toBeUndefined();
  });

  test.each([[''], ['---'], [42], [null]])('a `project` of %j is refused', async (configured) => {
    const outcome = await resolveDevProject({ packDir: root, configured, git: noGit });
    expect(outcome).toEqual({
      kind: 'invalid',
      message:
        '`project` in the Kindgi config must be a name with at least one letter or digit, e.g. "acme-app".',
    });
  });

  test("the repository's name, from its main checkout's folder", async () => {
    const outcome = await resolveDevProject({
      packDir: join(root, 'acme', 'packs', 'billing'),
      configured: undefined,
      git: gitAt({
        toplevel: join(root, 'acme'),
        gitDir: join(root, 'acme', '.git'),
        commonDir: join(root, 'acme', '.git'),
      }),
    });
    expect(outcome).toMatchObject({
      kind: 'ok',
      project: {
        name: 'acme',
        nameFrom: 'repository',
        root: join(root, 'acme'),
        database: 'kindgi_acme',
      },
    });
  });

  test("a linked worktree: the repository's name, plus git's name for the worktree", async () => {
    const outcome = await resolveDevProject({
      packDir: join(root, 'acme-login'),
      configured: undefined,
      git: gitAt({
        toplevel: join(root, 'acme-login'),
        gitDir: join(root, 'acme', '.git', 'worktrees', 'acme-login2'),
        commonDir: join(root, 'acme', '.git'),
      }),
    });
    expect(outcome).toMatchObject({
      kind: 'ok',
      project: {
        name: 'acme',
        nameFrom: 'repository',
        root: join(root, 'acme-login'),
        worktree: 'acme-login2',
        database: 'kindgi_acme__acme_login2',
      },
    });
  });

  test('a configured name in a worktree still gets the worktree suffix', async () => {
    const outcome = await resolveDevProject({
      packDir: join(root, 'wt'),
      configured: 'acme-app',
      git: gitAt({
        toplevel: join(root, 'wt'),
        gitDir: join(root, 'repo', '.git', 'worktrees', 'wt'),
        commonDir: join(root, 'repo', '.git'),
      }),
    });
    expect(outcome).toMatchObject({
      kind: 'ok',
      project: { name: 'acme-app', database: 'kindgi_acme_app__wt' },
    });
  });

  test('without git: the nearest workspace root, else the pack folder', async () => {
    await mkdir(join(root, 'acme', 'packs', 'billing'), { recursive: true });
    await writeFile(join(root, 'acme', 'pnpm-workspace.yaml'), 'packages: ["packs/*"]\n');
    const inWorkspace = await resolveDevProject({
      packDir: join(root, 'acme', 'packs', 'billing'),
      configured: undefined,
      git: noGit,
    });
    expect(inWorkspace).toMatchObject({
      kind: 'ok',
      project: {
        name: 'acme',
        nameFrom: 'workspace',
        root: join(root, 'acme'),
        database: 'kindgi_acme',
      },
    });

    // `kindgi init` gives a pack its own pnpm-workspace.yaml: still just the pack.
    await mkdir(join(root, 'solo-pack'));
    await writeFile(join(root, 'solo-pack', 'pnpm-workspace.yaml'), 'packages: []\n');
    const alone = await resolveDevProject({
      packDir: join(root, 'solo-pack'),
      configured: undefined,
      git: noGit,
    });
    expect(alone).toMatchObject({
      kind: 'ok',
      project: {
        name: 'solo-pack',
        nameFrom: 'pack folder',
        root: join(root, 'solo-pack'),
        database: 'kindgi_solo_pack',
      },
    });
  });
});

describe('findWorkspaceRoot', () => {
  test.each([
    ['pnpm-workspace.yaml', 'packages: ["*"]\n'],
    ['package.json', '{"name":"acme","workspaces":["packs/*"]}'],
    ['pyproject.toml', '[project]\nname = "acme"\n\n[tool.uv.workspace]\nmembers = ["packs/*"]\n'],
  ])('a %s that declares a workspace', async (file, content) => {
    await mkdir(join(root, 'acme', 'packs', 'billing'), { recursive: true });
    await writeFile(join(root, 'acme', file), content);
    expect(findWorkspaceRoot(join(root, 'acme', 'packs', 'billing'))).toBe(join(root, 'acme'));
  });

  test("a package.json without workspaces, or a pyproject without [tool.uv.workspace], isn't one", async () => {
    await mkdir(join(root, 'acme', 'pack'), { recursive: true });
    await writeFile(join(root, 'acme', 'package.json'), '{"name":"acme"}');
    await writeFile(join(root, 'acme', 'pack', 'pyproject.toml'), '[project]\nname = "pack"\n');
    expect(findWorkspaceRoot(join(root, 'acme', 'pack'))).not.toBe(join(root, 'acme'));
    expect(findWorkspaceRoot(join(root, 'acme', 'pack'))).not.toBe(join(root, 'acme', 'pack'));
  });
});

describe('locateGit, on a real repository and a linked worktree', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      stdio: 'pipe',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
    });

  test('the main checkout and a worktree resolve to one project, two databases', async () => {
    const main = join(root, 'acme');
    await mkdir(main);
    git(main, 'init', '-q', '-b', 'main');
    git(
      main,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    );
    git(main, 'worktree', 'add', '-q', join(root, 'acme-login'), '-b', 'login');

    const fromMain = await resolveDevProject({
      packDir: main,
      configured: undefined,
      git: locateGit,
    });
    const fromWorktree = await resolveDevProject({
      packDir: join(root, 'acme-login'),
      configured: undefined,
      git: locateGit,
    });
    expect(fromMain).toMatchObject({
      kind: 'ok',
      project: { name: 'acme', root: main, database: 'kindgi_acme' },
    });
    expect(fromWorktree).toMatchObject({
      kind: 'ok',
      project: {
        name: 'acme',
        root: join(root, 'acme-login'),
        worktree: 'acme-login',
        database: 'kindgi_acme__acme_login',
      },
    });
  });

  test('outside a repository: undefined', async () => {
    expect(await locateGit(root)).toBeUndefined();
  });
});
