// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What a pack image's install reads: the app's own lockfile and
 * manifests (the whole workspace's), its patches and local tarballs —
 * and registry config only as a build secret.
 */

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { installCommands, resolveHostInstall } from '../src/build/host-install.js';

let root: string;
const put = async (rel: string, body = '{}\n'): Promise<void> => {
  const abs = join(root, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, body, 'utf8');
};
const json = (value: unknown): string => `${JSON.stringify(value)}\n`;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'kindgi-host-install-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('resolveHostInstall', () => {
  test('a pnpm workspace: every member manifest, the workspace file, patches; .npmrc as a secret', async () => {
    await put(
      'package.json',
      json({ name: 'app', packageManager: 'pnpm@11.25.0', engines: { node: '24.x' } }),
    );
    await put('pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
    await put(
      'pnpm-workspace.yaml',
      "packages:\n  - '.'\n  - 'services/*'\npatchedDependencies:\n  left-pad@1.3.0: patches/left-pad.patch\n",
    );
    await put('patches/left-pad.patch', 'diff\n');
    await put('services/api/package.json', json({ name: 'api' }));
    await put('services/api/src/main.ts', '// not an install input\n');
    await put('tools/script/package.json', json({ name: 'not-a-member' }));
    await put('.npmrc', 'engine-strict=true\n');
    await put('kindgi.config.mts', 'export default {};\n');

    const outcome = await resolveHostInstall(root);
    expect(outcome).toEqual({
      kind: 'ok',
      install: {
        root,
        packRel: '',
        manager: 'pnpm',
        managerSpec: 'pnpm@11.25.0',
        yarnBerry: false,
        workspace: true,
        enginesNode: '24.x',
        files: [
          'package.json',
          'patches/left-pad.patch',
          'pnpm-lock.yaml',
          'pnpm-workspace.yaml',
          'services/api/package.json',
        ],
        secrets: [{ id: 'npmrc', file: '.npmrc' }],
      },
    });
  });

  test('a pack inside a monorepo installs from the root, with the pack at its own path', async () => {
    await put('package.json', json({ name: 'mono', workspaces: ['apps/*'] }));
    await put('package-lock.json', json({ lockfileVersion: 3 }));
    await put('apps/support/package.json', json({ name: 'support' }));
    await put('apps/support/kindgi.config.mts', 'export default {};\n');

    const outcome = await resolveHostInstall(join(root, 'apps', 'support'));
    if (outcome.kind !== 'ok') throw new Error(outcome.message);
    expect(outcome.install).toMatchObject({
      root,
      packRel: 'apps/support',
      manager: 'npm',
      files: ['apps/support/package.json', 'package-lock.json', 'package.json'],
      secrets: [],
    });
  });

  test('a local tarball inside the project ships; a package linked from outside it is refused', async () => {
    await put(
      'package.json',
      json({ name: 'app', dependencies: { '@acme/sdk': 'file:vendor/acme-sdk-1.0.0.tgz' } }),
    );
    await put('pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
    await put('vendor/acme-sdk-1.0.0.tgz', 'tgz');
    const ok = await resolveHostInstall(root);
    expect(ok.kind === 'ok' && ok.install.files).toContain('vendor/acme-sdk-1.0.0.tgz');

    await put(
      'package.json',
      json({ name: 'app', devDependencies: { '@acme/cli': 'link:../../elsewhere/cli' } }),
    );
    const refused = await resolveHostInstall(root);
    expect(refused).toMatchObject({ kind: 'err' });
    expect(refused.kind === 'err' && refused.message).toContain('Vendor it as a tarball');
  });

  test('tarballs that overrides or resolutions point at ship too; one outside the project is refused', async () => {
    // pnpm: the workspace file's overrides, and package.json's pnpm.overrides.
    await put(
      'package.json',
      json({
        name: 'app',
        dependencies: { '@acme/sdk': 'file:vendor/acme-sdk.tgz' },
        pnpm: { overrides: { '@acme/util': 'file:vendor/acme-util.tgz' } },
      }),
    );
    await put('pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
    await put(
      'pnpm-workspace.yaml',
      "overrides:\n  '@acme/types': file:vendor/acme-types.tgz\n  left-pad: 1.3.0\n",
    );
    for (const tgz of ['acme-sdk', 'acme-util', 'acme-types'])
      await put(`vendor/${tgz}.tgz`, 'tgz');
    const pnpm = await resolveHostInstall(root);
    if (pnpm.kind !== 'ok') throw new Error(pnpm.message);
    expect(pnpm.install.files).toEqual(
      expect.arrayContaining([
        'vendor/acme-sdk.tgz',
        'vendor/acme-util.tgz',
        'vendor/acme-types.tgz',
      ]),
    );

    await put('pnpm-workspace.yaml', "overrides:\n  '@acme/types': link:../../elsewhere/types\n");
    const outside = await resolveHostInstall(root);
    expect(outside.kind === 'err' && outside.message).toContain(
      '@acme/types is "link:../../elsewhere/types" in pnpm-workspace.yaml overrides, outside the project',
    );
  });

  test("npm's nested overrides and yarn's resolutions are read the same way", async () => {
    await put(
      'package.json',
      json({
        name: 'app',
        overrides: { foo: { '.': 'file:vendor/foo.tgz', bar: 'file:vendor/bar.tgz' } },
      }),
    );
    await put('package-lock.json', json({ lockfileVersion: 3 }));
    await put('vendor/foo.tgz', 'tgz');
    await put('vendor/bar.tgz', 'tgz');
    const npm = await resolveHostInstall(root);
    if (npm.kind !== 'ok') throw new Error(npm.message);
    expect(npm.install.files).toEqual(expect.arrayContaining(['vendor/foo.tgz', 'vendor/bar.tgz']));

    await rm(join(root, 'package-lock.json'));
    await put('package.json', json({ name: 'app', resolutions: { baz: 'file:vendor/baz.tgz' } }));
    await put('yarn.lock', '# yarn lockfile v1\n');
    await put('vendor/baz.tgz', 'tgz');
    const yarn = await resolveHostInstall(root);
    if (yarn.kind !== 'ok') throw new Error(yarn.message);
    expect(yarn.install.files).toContain('vendor/baz.tgz');
  });

  test('yarn berry needs a node_modules linker; with one, its config is a secret and .yarn/ ships', async () => {
    await put('package.json', json({ name: 'app' }));
    await put('yarn.lock', '__metadata:\n  version: 8\n');
    expect(await resolveHostInstall(root)).toMatchObject({ kind: 'err' });

    await put('.yarnrc.yml', 'nodeLinker: node-modules\n');
    await put('.yarn/releases/yarn-4.5.0.cjs', '// yarn\n');
    const outcome = await resolveHostInstall(root);
    if (outcome.kind !== 'ok') throw new Error(outcome.message);
    expect(outcome.install).toMatchObject({
      manager: 'yarn',
      yarnBerry: true,
      secrets: [{ id: 'yarnrc-yml', file: '.yarnrc.yml' }],
    });
    expect(outcome.install.files).toContain('.yarn/releases/yarn-4.5.0.cjs');
  });

  test('no lockfile, bun, or a packageManager the lockfile contradicts: refused, saying why', async () => {
    await put('package.json', json({ name: 'app' }));
    expect(await resolveHostInstall(root)).toMatchObject({ kind: 'err' });

    await put('bun.lock', '{}');
    const bun = await resolveHostInstall(root);
    expect(bun.kind === 'err' && bun.message).toContain('bun');
    await rm(join(root, 'bun.lock'));

    await put('package.json', json({ name: 'app', packageManager: 'yarn@4.5.0' }));
    await put('pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
    const mismatch = await resolveHostInstall(root);
    expect(mismatch.kind === 'err' && mismatch.message).toContain('Make them agree');
  });
});

describe('installCommands', () => {
  const base = {
    root: '/repo',
    packRel: '',
    yarnBerry: false,
    workspace: false,
    files: [],
    secrets: [],
  } as const;

  test.each([
    [
      'pnpm',
      false,
      'pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild',
      'pnpm prune --prod',
    ],
    [
      'npm',
      false,
      'npm ci --ignore-scripts --no-audit --no-fund && npm rebuild',
      'npm prune --omit=dev --no-audit --no-fund',
    ],
    ['yarn', true, 'yarn install --immutable', 'yarn workspaces focus --all --production'],
  ] as const)('%s (berry: %s)', (manager, yarnBerry, install, prune) => {
    expect(installCommands({ ...base, manager, yarnBerry })).toEqual({ install, prune });
  });
});
