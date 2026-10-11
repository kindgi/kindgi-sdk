// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi init` keeps a coding agent out of the files that hold keys
 * (`init/agent-access.ts`): a merge into `.claude/settings.json` that never
 * overwrites, and another agent's ignore file only when it exists.
 */

import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  KEY_FILES,
  agentAccessRows,
  claudeReadDenyRules,
  gitRootOf,
  globLiteral,
  patchAgentAccess,
  patchClaudeSettings,
  writeAgentAccess,
} from '../src/init/agent-access.js';

let dir: string;
let settings: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kindgi-agent-access-'));
  settings = join(dir, '.claude', 'settings.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const RULES = [
  'Read(./.env*)',
  'Read(./.kindgi/secrets.env)',
  'Read(./.kindgi/dev/runtime.env)',
  'Read(./kindgi.env)',
  'Read(./pack.env)',
];

describe('KEY_FILES', () => {
  test("the key files; not .kindgirc.json, which the agent's own kindgi commands read", () => {
    expect(claudeReadDenyRules()).toEqual(RULES);
    expect(KEY_FILES).not.toContain('.kindgirc.json');
  });
});

describe('patchClaudeSettings', () => {
  test('no settings file: created with the deny rules', async () => {
    expect(await patchClaudeSettings(settings)).toEqual({ kind: 'created', appended: RULES });
    expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({
      permissions: { deny: RULES },
    });
  });

  test('an existing file: only the missing rules appended, the rest kept, its indentation too', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    const before = {
      model: 'sonnet',
      permissions: { allow: ['Bash(npm test)'], deny: ['Read(./secrets/**)', 'Read(./.env*)'] },
      hooks: {},
    };
    await writeFile(settings, `${JSON.stringify(before, null, 4)}\n`);
    const r = await patchClaudeSettings(settings);

    expect(r.kind).toBe('patched');
    expect(r.appended).toEqual(RULES.filter((x) => x !== 'Read(./.env*)'));
    const raw = await readFile(settings, 'utf8');
    expect(raw).toContain('\n    "model": "sonnet"');
    expect(JSON.parse(raw)).toEqual({
      model: 'sonnet',
      permissions: {
        allow: ['Bash(npm test)'],
        deny: ['Read(./secrets/**)', 'Read(./.env*)', ...r.appended],
      },
      hooks: {},
    });
  });

  test('every rule there already: nothing written', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(settings, JSON.stringify({ permissions: { deny: RULES } }));
    const mtime = (await stat(settings)).mtimeMs;
    expect(await patchClaudeSettings(settings)).toEqual({ kind: 'already-present', appended: [] });
    expect((await stat(settings)).mtimeMs).toBe(mtime);
  });

  test.each([
    ['not JSON', '{ "permissions": { // a comment\n } }', "isn't valid JSON"],
    ['a deny that is not a list', '{"permissions":{"deny":"Read(x)"}}', "isn't a list"],
    ['permissions that are not an object', '{"permissions":[]}', "isn't an object"],
  ])('%s: left as it is, and the message says what to add', async (_label, contents, says) => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(settings, contents);
    const r = await patchClaudeSettings(settings);

    expect(r.kind).toBe('error');
    expect(r.message).toContain(says);
    expect(r.message).toContain('"Read(./.kindgi/secrets.env)"');
    expect(await readFile(settings, 'utf8')).toBe(contents);
  });
});

describe('patchAgentAccess', () => {
  test("another agent's ignore file: patched only when the project has one", async () => {
    await writeFile(join(dir, '.cursorignore'), 'dist/\n');
    const result = await patchAgentAccess(dir);

    expect(result.claude.kind).toBe('created');
    expect(result.others.map((o) => o.file)).toEqual(['.cursorignore']);
    expect(await readFile(join(dir, '.cursorignore'), 'utf8')).toBe(
      `dist/\n\n# Kindgi\n${KEY_FILES.join('\n')}\n`,
    );
    await expect(stat(join(dir, '.geminiignore'))).rejects.toThrow();
  });

  test('the summary rows: created, then already present; a broken file is a warning, never a failure', async () => {
    const first = agentAccessRows(dir, await patchAgentAccess(dir));
    expect(first.created).toEqual([
      `${settings} (your coding agent's file tools stay out of the files that hold keys)`,
    ]);
    const again = agentAccessRows(dir, await patchAgentAccess(dir));
    expect(again.skipped).toEqual([`${settings} (the key-file deny rules already present)`]);

    await writeFile(settings, 'not json');
    const broken = agentAccessRows(dir, await patchAgentAccess(dir));
    expect(broken.created).toEqual([]);
    expect(broken.warnings[0]).toContain("isn't valid JSON, so it's left as it is");
  });
});

describe('a pack below its git root (a monorepo)', () => {
  /** `dir` is the repository: a `.git` folder, the pack at `packPath` below it. */
  async function repoWithPack(packPath: string, git: 'dir' | 'file' = 'dir'): Promise<string> {
    if (git === 'dir') await mkdir(join(dir, '.git'));
    else await writeFile(join(dir, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
    const pack = join(dir, ...packPath.split('/'));
    await mkdir(pack, { recursive: true });
    return pack;
  }
  const rootSettings = () => join(dir, '.claude', 'settings.json');
  const WHY = "so an agent started at the repo root can't read this pack's keys";

  test('gitRootOf: the nearest .git, a folder or a file, at or above', async () => {
    const pack = await repoWithPack('apps/agent');
    expect(await gitRootOf(pack)).toBe(dir);
    expect(await gitRootOf(dir)).toBe(dir);
    await rm(join(dir, '.git'), { recursive: true });
    await writeFile(join(dir, '.git'), 'gitdir: /elsewhere\n');
    expect(await gitRootOf(pack)).toBe(dir);
  });

  test("the root's settings get the rules under the pack's path; the pack's own file keeps its own", async () => {
    const pack = await repoWithPack('apps/agent');
    const result = await patchAgentAccess(pack);

    expect(JSON.parse(await readFile(join(pack, '.claude', 'settings.json'), 'utf8'))).toEqual({
      permissions: { deny: RULES },
    });
    const rootRules = RULES.map((r) => r.replace('Read(./', 'Read(./apps/agent/'));
    expect(rootRules[0]).toBe('Read(./apps/agent/.env*)');
    expect(JSON.parse(await readFile(rootSettings(), 'utf8'))).toEqual({
      permissions: { deny: rootRules },
    });
    expect(result.repoRoot).toMatchObject({ dir, prefix: 'apps/agent' });

    const rows = agentAccessRows(pack, result);
    const line = `${rootSettings()}: created with 5 deny rules for apps/agent/, ${WHY}`;
    expect(rows.outside).toEqual([line]);
    expect(rows.created).toContain(line);
  });

  test('nested deeper: the whole path is the prefix', async () => {
    const pack = await repoWithPack('services/billing/kindgi-pack');
    await patchAgentAccess(pack);
    const deny = (
      JSON.parse(await readFile(rootSettings(), 'utf8')) as {
        permissions: { deny: string[] };
      }
    ).permissions.deny;
    expect(deny).toContain('Read(./services/billing/kindgi-pack/.kindgi/secrets.env)');
  });

  test("a worktree's or submodule's .git file counts as the root", async () => {
    const pack = await repoWithPack('apps/agent', 'file');
    expect((await patchAgentAccess(pack)).repoRoot?.prefix).toBe('apps/agent');
  });

  test("the root's own rules are kept, in order; a second run writes nothing anywhere", async () => {
    const pack = await repoWithPack('apps/agent');
    await mkdir(join(dir, '.claude'), { recursive: true });
    const before = { permissions: { deny: ['Read(./infra/**)', 'Bash(rm -rf:*)'] }, model: 'opus' };
    await writeFile(rootSettings(), `${JSON.stringify(before, null, 2)}\n`);
    const first = await patchAgentAccess(pack);
    expect(first.repoRoot).toMatchObject({ claude: { kind: 'patched' } });
    const after = JSON.parse(await readFile(rootSettings(), 'utf8')) as {
      permissions: { deny: string[] };
      model: string;
    };
    expect(after.permissions.deny.slice(0, 2)).toEqual(['Read(./infra/**)', 'Bash(rm -rf:*)']);
    expect(after.permissions.deny).toHaveLength(7);
    expect(after.model).toBe('opus');
    expect(agentAccessRows(pack, first).outside).toEqual([
      `${rootSettings()}: added 5 deny rules for apps/agent/, ${WHY}`,
    ]);

    const rootBytes = await readFile(rootSettings(), 'utf8');
    const packBytes = await readFile(join(pack, '.claude', 'settings.json'), 'utf8');
    const again = await patchAgentAccess(pack);
    expect(again.claude.kind).toBe('already-present');
    expect(again.repoRoot).toMatchObject({ claude: { kind: 'already-present' } });
    expect(await readFile(rootSettings(), 'utf8')).toBe(rootBytes);
    expect(await readFile(join(pack, '.claude', 'settings.json'), 'utf8')).toBe(packBytes);
    const rows = agentAccessRows(pack, again);
    expect(rows.outside).toEqual([]);
    expect(rows.skipped).toContain(
      `${rootSettings()} (the deny rules for apps/agent/ already present)`,
    );
  });

  test("a root settings file that isn't JSON: left as it is, a warning that says what to add and why", async () => {
    const pack = await repoWithPack('apps/agent');
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(rootSettings(), '{ // mine\n}');
    const rows = agentAccessRows(pack, await patchAgentAccess(pack));

    expect(await readFile(rootSettings(), 'utf8')).toBe('{ // mine\n}');
    expect(rows.outside).toEqual([]);
    expect(rows.warnings).toHaveLength(1);
    expect(rows.warnings[0]).toContain("isn't valid JSON, so it's left as it is");
    expect(rows.warnings[0]).toContain('"Read(./apps/agent/.env*)"');
    expect(rows.warnings[0]).toContain(WHY);
    expect(rows.created).toContain(
      `${join(pack, '.claude', 'settings.json')} (your coding agent's file tools stay out of the files that hold keys)`,
    );
  });

  test("another agent's ignore file at the root: patched under the pack's path only when it exists", async () => {
    const pack = await repoWithPack('apps/agent');
    await writeFile(join(dir, '.cursorignore'), 'node_modules/\n');
    const rows = agentAccessRows(pack, await patchAgentAccess(pack));

    expect(await readFile(join(dir, '.cursorignore'), 'utf8')).toBe(
      `node_modules/\n\n# Kindgi\n${KEY_FILES.map((f) => `apps/agent/${f}`).join('\n')}\n`,
    );
    expect(rows.outside).toContain(
      `${join(dir, '.cursorignore')}: added ${KEY_FILES.map((f) => `apps/agent/${f}`).join(', ')}, ${WHY}`,
    );
    await expect(stat(join(dir, '.geminiignore'))).rejects.toThrow();
  });

  test('the pack at its git root: nothing outside its folder', async () => {
    await mkdir(join(dir, '.git'));
    const atRoot = await patchAgentAccess(dir);
    expect(atRoot.repoRoot).toBeUndefined();
    expect(agentAccessRows(dir, atRoot).outside).toEqual([]);
    expect(JSON.parse(await readFile(rootSettings(), 'utf8'))).toEqual({
      permissions: { deny: RULES },
    });
  });

  test('the repo root is the home folder (a dotfiles repository): nothing written there, and init says why', async () => {
    const pack = await repoWithPack('scratch/my-pack');
    const result = await patchAgentAccess(pack, { home: dir });
    expect(result.repoRoot).toEqual({ dir, prefix: 'scratch/my-pack', skipped: 'home' });
    await expect(stat(join(dir, '.claude'))).rejects.toThrow();

    const rows = agentAccessRows(pack, result);
    expect(rows.outside).toEqual([]);
    expect(rows.warnings).toEqual([
      `${rootSettings()} not written: the repo root is your home folder; add the rules yourself if you want them there: ${RULES.map((r) => JSON.stringify(r.replace('Read(./', 'Read(./scratch/my-pack/'))).join(', ')}.`,
    ]);
    // The pack's own file is written as ever.
    expect(rows.created).toContain(
      `${join(pack, '.claude', 'settings.json')} (your coding agent's file tools stay out of the files that hold keys)`,
    );
  });

  test('the home folder is compared with links resolved', async () => {
    const pack = await repoWithPack('scratch/my-pack');
    const link = join(await mkdtemp(join(tmpdir(), 'kindgi-home-link-')), 'home');
    await symlink(dir, link);
    expect((await patchAgentAccess(pack, { home: link })).repoRoot).toMatchObject({
      skipped: 'home',
    });
    await rm(dirname(link), { recursive: true, force: true });
  });

  test('a pack folder with glob characters: its path written as a literal', async () => {
    const pack = await repoWithPack('apps/[legacy]/agent*');
    await writeFile(join(dir, '.cursorignore'), 'dist/\n');
    await patchAgentAccess(pack);
    const deny = (
      JSON.parse(await readFile(rootSettings(), 'utf8')) as {
        permissions: { deny: string[] };
      }
    ).permissions.deny;
    expect(deny[0]).toBe('Read(./apps/\\[legacy\\]/agent\\*/.env*)');
    expect(await readFile(join(dir, '.cursorignore'), 'utf8')).toContain(
      'apps/\\[legacy\\]/agent\\*/.kindgi/secrets.env\n',
    );
  });

  test('no repository above: nothing outside its folder', async () => {
    const loose = join(dir, 'loose');
    await mkdir(loose);
    expect(await gitRootOf(loose)).toBeUndefined();
    expect((await patchAgentAccess(loose)).repoRoot).toBeUndefined();
    await expect(stat(join(dir, '.claude'))).rejects.toThrow();
  });
});

describe('patchClaudeSettings: a byte-order mark', () => {
  test('read past, and kept', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(settings, '﻿{"model":"opus"}');
    expect((await patchClaudeSettings(settings)).kind).toBe('patched');
    const raw = await readFile(settings, 'utf8');
    expect(raw.startsWith('﻿{')).toBe(true);
    expect(JSON.parse(raw.slice(1))).toEqual({ model: 'opus', permissions: { deny: RULES } });
  });
});

describe('writeAgentAccess (a new pack)', () => {
  test("a settings file that isn't JSON: a warning line, not a failure", async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(settings, 'not json');
    const out = await writeAgentAccess(dir);
    expect(out.files).toEqual([]);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toMatch(/^⚠ .*isn't valid JSON, so it's left as it is/);
  });

  test("below a git root: the pack's file in the list, the root's on its own line", async () => {
    await mkdir(join(dir, '.git'));
    const pack = join(dir, 'my-pack');
    await mkdir(pack);
    const out = await writeAgentAccess(pack);
    expect(out.files).toEqual([join(pack, '.claude', 'settings.json')]);
    expect(out.lines).toEqual([
      `✓ ${join(dir, '.claude', 'settings.json')}: created with 5 deny rules for my-pack/, so an agent started at the repo root can't read this pack's keys`,
    ]);
  });
});

describe('globLiteral', () => {
  test('escapes what a gitignore-style pattern would read as a glob, and a leading # or !', () => {
    expect(globLiteral('apps/agent')).toBe('apps/agent');
    expect(globLiteral('apps/[legacy]/a*b?c\\d')).toBe('apps/\\[legacy\\]/a\\*b\\?c\\\\d');
    expect(globLiteral('#notes/x')).toBe('\\#notes/x');
    expect(globLiteral('!keep/x')).toBe('\\!keep/x');
    expect(globLiteral('a/#b')).toBe('a/#b');
  });
});
