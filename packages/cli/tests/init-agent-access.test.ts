// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi init` keeps a coding agent out of the files that hold keys
 * (`init/agent-access.ts`): a merge into `.claude/settings.json` that never
 * overwrites, and another agent's ignore file only when it exists.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  KEY_FILES,
  agentAccessRows,
  claudeReadDenyRules,
  patchAgentAccess,
  patchClaudeSettings,
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
