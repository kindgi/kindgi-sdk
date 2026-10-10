// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import semver from 'semver';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { TESTED_ZOD_VERSION, pinsExactly, savesExact, specAt } from '../src/init/pinning.js';

describe('the tested zod', () => {
  const sdkDir = fileURLToPath(new URL('../../sdk/', import.meta.url));

  test("is the zod the workspace runs Kindgi's tests with: bump it with the lockfile", () => {
    const installed = createRequire(join(sdkDir, 'package.json'))('zod/package.json') as {
      version: string;
    };
    expect(TESTED_ZOD_VERSION).toBe(installed.version);
  });

  test("is inside @kindgi/sdk's zod range", async () => {
    const sdk = JSON.parse(await readFile(join(sdkDir, 'package.json'), 'utf8')) as {
      peerDependencies: Record<string, string>;
    };
    const range = sdk.peerDependencies.zod;
    expect(range).toBeDefined();
    expect(semver.satisfies(TESTED_ZOD_VERSION, range as string)).toBe(true);
  });
});

describe('specAt', () => {
  test('exact, or a caret range from the version', () => {
    expect(specAt('4.6.5', true)).toBe('4.6.5');
    expect(specAt('4.6.5', false)).toBe('^4.6.5');
  });
});

describe('pinsExactly', () => {
  test('every semver spec exact: yes', () => {
    expect(
      pinsExactly({
        dependencies: { next: '16.4.0', react: '19.3.0' },
        devDependencies: { typescript: '5.9.3' },
      }),
    ).toBe(true);
  });

  test('one range anywhere: no', () => {
    expect(pinsExactly({ dependencies: { next: '16.4.0', react: '^19.3.0' } })).toBe(false);
    expect(pinsExactly({ dependencies: { next: '16.4.0' }, devDependencies: { x: '~1.2' } })).toBe(
      false,
    );
    expect(pinsExactly({ dependencies: { next: '16.4.0', any: '*' } })).toBe(false);
    expect(pinsExactly({ optionalDependencies: { fsevents: '>=2' } })).toBe(false);
  });

  test("specs that aren't semver say nothing; peer ranges don't count", () => {
    expect(
      pinsExactly({
        dependencies: {
          next: '16.4.0',
          ui: 'workspace:*',
          cat: 'catalog:',
          local: 'file:../local',
          tag: 'latest',
          git: 'github:acme/lib',
        },
        peerDependencies: { react: '^19.0.0' },
      }),
    ).toBe(true);
  });

  test('nothing pinned at all: no', () => {
    expect(pinsExactly({})).toBe(false);
    expect(pinsExactly({ dependencies: { ui: 'workspace:*' } })).toBe(false);
  });
});

describe('savesExact', () => {
  let dir: string;
  let home: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kindgi-pinning-'));
    home = await mkdtemp(join(tmpdir(), 'kindgi-pinning-home-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  test('no settings: no', async () => {
    expect(await savesExact(dir, home)).toBe(false);
  });

  test(".npmrc's save-exact or an empty save-prefix: yes", async () => {
    await writeFile(join(dir, '.npmrc'), 'save-exact=true\n');
    expect(await savesExact(dir, home)).toBe(true);
    await writeFile(join(dir, '.npmrc'), "save-prefix=''\n");
    expect(await savesExact(dir, home)).toBe(true);
    await writeFile(join(dir, '.npmrc'), 'save-prefix=~\n');
    expect(await savesExact(dir, home)).toBe(false);
  });

  test("the user's ~/.npmrc, unless the project's says otherwise", async () => {
    await writeFile(join(home, '.npmrc'), 'save-exact=true\n');
    expect(await savesExact(dir, home)).toBe(true);
    await writeFile(join(dir, '.npmrc'), 'save-exact=false\n');
    expect(await savesExact(dir, home)).toBe(false);
  });

  test('pnpm-workspace.yaml, .yarnrc.yml and bunfig.toml', async () => {
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages: []\nsaveExact: true\n');
    expect(await savesExact(dir)).toBe(true);
    await rm(join(dir, 'pnpm-workspace.yaml'));
    await writeFile(join(dir, '.yarnrc.yml'), 'defaultSemverRangePrefix: ""\n');
    expect(await savesExact(dir)).toBe(true);
    await rm(join(dir, '.yarnrc.yml'));
    await writeFile(join(dir, 'bunfig.toml'), '[test]\nexact = true\n');
    expect(await savesExact(dir)).toBe(false);
    await writeFile(join(dir, 'bunfig.toml'), '[install]\nexact = true\n');
    expect(await savesExact(dir)).toBe(true);
  });
});
