// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `copyToKindgiFile` (`kindgi secrets copy`): Kindgi gets its own copy of a
 * key from the app's env files; the app's files are never edited.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { copyToKindgiFile, namesInAppFiles, readPackEnv } from '../src/index.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kindgi-secrets-copy-'));
});

afterEach(async () => {
  await chmod(join(dir, '.env.local'), 0o600).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

const put = (name: string, body: string, mode = 0o644): Promise<void> =>
  writeFile(join(dir, name), body, { mode });
const read = (name: string): Promise<string> => readFile(join(dir, name), 'utf8');
const modeOf = async (name: string): Promise<number> => (await stat(join(dir, name))).mode & 0o777;
const KINDGI = '.kindgi/secrets.env';

async function putKindgi(body: string): Promise<void> {
  await mkdir(join(dir, '.kindgi'), { recursive: true });
  await writeFile(join(dir, KINDGI), body, { mode: 0o600 });
}

describe('copyToKindgiFile', () => {
  test("copies a key into Kindgi's file (0600); the app's file is untouched, its mode too", async () => {
    await put('.env.local', '# mine\nANTHROPIC_API_KEY=sk-app\nOTHER=1\n');
    const r = await copyToKindgiFile({ packDir: dir, names: ['ANTHROPIC_API_KEY'] });

    expect(r.kindgiFile).toBe(join(dir, KINDGI));
    expect(r.names).toEqual([
      { name: 'ANTHROPIC_API_KEY', appFiles: [join(dir, '.env.local')], copied: true },
    ]);
    expect(await read(KINDGI)).toBe('ANTHROPIC_API_KEY=sk-app\n');
    expect(await modeOf(KINDGI)).toBe(0o600);
    expect(await read('.env.local')).toBe('# mine\nANTHROPIC_API_KEY=sk-app\nOTHER=1\n');
    expect(await modeOf('.env.local')).toBe(0o644);
  });

  test("the app's highest-precedence value is the one copied; every holding file is named", async () => {
    await put('.env', 'OPENAI_API_KEY=from-env\n');
    await put('.env.local', 'OPENAI_API_KEY=from-local\n');
    const r = await copyToKindgiFile({ packDir: dir, names: ['OPENAI_API_KEY'] });

    expect(r.names[0]?.appFiles).toEqual([join(dir, '.env'), join(dir, '.env.local')]);
    expect(await read(KINDGI)).toBe('OPENAI_API_KEY=from-local\n');
  });

  test("merge only: Kindgi's other lines stay", async () => {
    await putKindgi('# kindgi\nMCP_TOKEN=t\n');
    await put('.env.local', 'GROQ_API_KEY=g\n');
    await copyToKindgiFile({ packDir: dir, names: ['GROQ_API_KEY'] });

    expect(await read(KINDGI)).toBe('# kindgi\nMCP_TOKEN=t\nGROQ_API_KEY=g\n');
  });

  test("already in Kindgi's file with the same value: nothing written", async () => {
    await putKindgi('ANTHROPIC_API_KEY=sk-same\n');
    await put('.env.local', 'ANTHROPIC_API_KEY=sk-same\n');
    const r = await copyToKindgiFile({ packDir: dir, names: ['ANTHROPIC_API_KEY'] });

    expect(r.names[0]).toMatchObject({ copied: false, alreadyInKindgiFile: 'same' });
    expect(await read(KINDGI)).toBe('ANTHROPIC_API_KEY=sk-same\n');
  });

  test('the same name, two values: Kindgi keeps its own key, the app keeps its own', async () => {
    await putKindgi('ANTHROPIC_API_KEY=sk-kindgi\n');
    await put('.env.local', 'ANTHROPIC_API_KEY=sk-app\n');
    const r = await copyToKindgiFile({ packDir: dir, names: ['ANTHROPIC_API_KEY'] });

    expect(r.names[0]).toMatchObject({ copied: false, alreadyInKindgiFile: 'different' });
    expect(await read(KINDGI)).toBe('ANTHROPIC_API_KEY=sk-kindgi\n');
    expect(await read('.env.local')).toBe('ANTHROPIC_API_KEY=sk-app\n');
  });

  test('a name no app file holds: nothing done, nothing written', async () => {
    const r = await copyToKindgiFile({ packDir: dir, names: ['NOT_THERE'] });

    expect(r.names).toEqual([{ name: 'NOT_THERE', appFiles: [], copied: false }]);
    await expect(stat(join(dir, KINDGI))).rejects.toThrow();
  });

  test('a ${VAR} reference is copied as its line is written, and resolves as before', async () => {
    await put('.env.local', 'ANTHROPIC_API_KEY=${SHELL_KEY}\nexport OTHER_KEY="a b"\n');
    const env = { SHELL_KEY: 'from-shell' };
    const before = await readPackEnv({ packDir: dir, envName: 'local', env });
    await copyToKindgiFile({ packDir: dir, names: ['ANTHROPIC_API_KEY', 'OTHER_KEY'] });

    expect(await read(KINDGI)).toBe('ANTHROPIC_API_KEY=${SHELL_KEY}\nexport OTHER_KEY="a b"\n');
    const after = await readPackEnv({ packDir: dir, envName: 'local', env });
    expect(after.values.ANTHROPIC_API_KEY).toBe('from-shell');
    expect(after.values).toEqual(before.values);
    expect(after.origin.ANTHROPIC_API_KEY).toBe(join(dir, KINDGI));
  });

  test.skipIf(process.getuid?.() === 0)(
    "an app file it can't read is skipped and named",
    async () => {
      await put('.env', 'ANTHROPIC_API_KEY=from-env\n');
      await put('.env.local', 'ANTHROPIC_API_KEY=from-local\n', 0o000);
      const r = await copyToKindgiFile({ packDir: dir, names: ['ANTHROPIC_API_KEY'] });

      expect(r.skipped).toEqual([{ file: join(dir, '.env.local'), reason: 'permission denied' }]);
      expect(await read(KINDGI)).toBe('ANTHROPIC_API_KEY=from-env\n');
    },
  );
});

describe('namesInAppFiles', () => {
  test("finds a name in the app's files even when Kindgi's file shadows it", async () => {
    await putKindgi('ANTHROPIC_API_KEY=sk-kindgi\n');
    await put('.env.local', 'ANTHROPIC_API_KEY=sk-app\nOPENAI_API_KEY=o\n');

    expect(
      await namesInAppFiles({
        packDir: dir,
        names: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY'],
      }),
    ).toEqual([
      { name: 'ANTHROPIC_API_KEY', files: [join(dir, '.env.local')], inKindgiFile: true },
      { name: 'OPENAI_API_KEY', files: [join(dir, '.env.local')], inKindgiFile: false },
    ]);
  });
});
