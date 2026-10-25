// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What a pack image's install reads: the app's own lockfile and
 * manifests (the whole workspace's), its patches and local tarballs —
 * and registry config only as a build secret.
 */

import { execFileSync, execSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  devOnlyImports,
  installCommands,
  readPackDependencies,
  resolveHostInstall,
  whyDevDependencies,
  withoutInstallScripts,
} from '../src/build/host-install.js';
import { installLine, patchPackageWarnings, skippedScriptLines } from '../src/commands/build.js';

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
        projectManifests: ['package.json', 'services/api/package.json'],
        skippedScripts: [],
        packDependencies: { runtime: [], dev: [] },
        secrets: [{ id: 'npmrc', file: '.npmrc' }],
      },
    });
  });

  test("the pack project's own dependencies: what the image keeps, and what it leaves out", async () => {
    await put(
      'package.json',
      json({ name: 'mono', workspaces: ['apps/*'], dependencies: { 'left-pad': '1.3.0' } }),
    );
    await put('package-lock.json', json({ lockfileVersion: 3 }));
    await put(
      'apps/support/package.json',
      json({
        name: 'support',
        dependencies: { zod: '4.0.0', '@acme/db': '1.0.0' },
        optionalDependencies: { sharp: '0.34.0' },
        peerDependencies: { react: '19.0.0' },
        devDependencies: { '@acme/db-client': '1.0.0', vitest: '3.0.0' },
      }),
    );
    const outcome = await resolveHostInstall(join(root, 'apps', 'support'));
    if (outcome.kind !== 'ok') throw new Error(outcome.message);
    expect(outcome.install.packDependencies).toEqual({
      runtime: ['@acme/db', 'react', 'sharp', 'zod'],
      dev: ['@acme/db-client', 'vitest'],
    });
    // What `kindgi dev` reads on each save: the same names, without the install.
    expect(await readPackDependencies(join(root, 'apps', 'support'))).toEqual(
      outcome.install.packDependencies,
    );
    expect(await readPackDependencies(root)).toEqual({ runtime: ['left-pad'], dev: [] });
  });

  test("a pack in a pnpm workspace member: the member's own manifest, not the root's", async () => {
    await put(
      'package.json',
      json({ name: 'mono', packageManager: 'pnpm@11.25.0', devDependencies: { ms: '2.1.3' } }),
    );
    await put('pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
    await put('pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n");
    await put(
      'apps/support/package.json',
      json({
        name: 'support',
        dependencies: { ms: '2.1.3' },
        devDependencies: { nanoid: '5.0.0' },
      }),
    );
    const outcome = await resolveHostInstall(join(root, 'apps', 'support'));
    if (outcome.kind !== 'ok') throw new Error(outcome.message);
    expect(outcome.install.packDependencies).toEqual({ runtime: ['ms'], dev: ['nanoid'] });
    expect(await readPackDependencies(join(root, 'apps', 'support'))).toEqual(
      outcome.install.packDependencies,
    );
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
      projectManifests: ['apps/support/package.json', 'package.json'],
      secrets: [],
    });
  });

  test("a local folder dependency's manifest ships, but isn't one of the app's project manifests", async () => {
    await put(
      'package.json',
      json({ name: 'app', dependencies: { '@acme/local': 'file:vendor/local' } }),
    );
    await put('pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
    await put(
      'vendor/local/package.json',
      json({ name: '@acme/local', scripts: { install: 'node build.js' } }),
    );
    const outcome = await resolveHostInstall(root);
    if (outcome.kind !== 'ok') throw new Error(outcome.message);
    expect(outcome.install.files).toContain('vendor/local/package.json');
    expect(outcome.install.projectManifests).toEqual(['package.json']);
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

/** `prisma()`'s build step. */
const PRISMA_STEPS = [{ extension: 'prisma', bin: 'prisma', args: ['generate'] }] as const;

describe('installCommands', () => {
  const base = {
    root: '/repo',
    packRel: '',
    yarnBerry: false,
    workspace: false,
    files: [],
    projectManifests: [],
    skippedScripts: [],
    packDependencies: { runtime: [], dev: [] },
    secrets: [],
  } as const;
  const member = "--filter '{./apps/support}...'";

  // No build steps: production dependencies only, so no dev dependency is
  // downloaded, and nothing to prune.
  test.each([
    [
      'pnpm',
      { manager: 'pnpm' },
      'pnpm install --frozen-lockfile --ignore-scripts --prod && pnpm rebuild',
    ],
    [
      'a pnpm workspace',
      { manager: 'pnpm', workspace: true, packRel: 'apps/support' },
      `pnpm install --frozen-lockfile --ignore-scripts --prod ${member} && pnpm ${member} rebuild`,
    ],
    [
      'npm',
      { manager: 'npm' },
      'npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm rebuild',
    ],
    [
      'yarn classic',
      { manager: 'yarn' },
      'yarn install --production --frozen-lockfile --ignore-scripts --non-interactive && npm rebuild',
    ],
  ] as const)('%s, no build steps: production dependencies only, no prune', (_, over, install) => {
    expect(installCommands({ ...base, ...over }, [])).toStrictEqual({ install });
  });

  // Build steps: dev dependencies too, for the steps' tools, then the prune.
  // Yarn berry the same without any: its production install resolves what yarn.lock lacks.
  test.each([
    [
      'pnpm, a build step',
      { manager: 'pnpm' },
      PRISMA_STEPS,
      'pnpm install --frozen-lockfile --ignore-scripts --prod=false && pnpm rebuild',
      'pnpm prune --prod',
    ],
    [
      'a pnpm workspace, a build step',
      { manager: 'pnpm', workspace: true, packRel: 'apps/support' },
      PRISMA_STEPS,
      `pnpm install --frozen-lockfile --ignore-scripts --prod=false ${member} && pnpm ${member} rebuild`,
      `pnpm install --frozen-lockfile --ignore-scripts --prod --config.confirm-modules-purge=false ${member}`,
    ],
    [
      'npm, a build step',
      { manager: 'npm' },
      PRISMA_STEPS,
      'npm ci --include=dev --ignore-scripts --no-audit --no-fund && npm rebuild',
      'npm prune --omit=dev --no-audit --no-fund',
    ],
    [
      'yarn classic, a build step',
      { manager: 'yarn' },
      PRISMA_STEPS,
      'yarn install --production=false --frozen-lockfile --ignore-scripts --non-interactive && npm rebuild',
      'yarn install --production --frozen-lockfile --ignore-scripts --non-interactive && npm rebuild',
    ],
    [
      'yarn berry, a build step',
      { manager: 'yarn', yarnBerry: true },
      PRISMA_STEPS,
      'yarn install --immutable',
      'yarn workspaces focus --all --production',
    ],
    [
      'yarn berry, no build steps',
      { manager: 'yarn', yarnBerry: true },
      [],
      'yarn install --immutable',
      'yarn workspaces focus --all --production',
    ],
  ] as const)('%s: dev dependencies too, then the prune', (_, over, steps, install, prune) => {
    expect(installCommands({ ...base, ...over }, steps)).toStrictEqual({ install, prune });
  });

  // buildEnv's ENV lines come before the install, and NODE_ENV=production
  // narrows npm's, yarn classic's and pnpm 9's install to production. With
  // build steps the install asks for dev dependencies, as the production one
  // asks for production only. Each: the manager, its production flag, its dev one.
  const asked = [
    ['pnpm', { manager: 'pnpm' }, '--prod', '--prod=false'],
    [
      'a pnpm workspace',
      { manager: 'pnpm', workspace: true, packRel: 'apps/support' },
      '--prod',
      '--prod=false',
    ],
    ['npm', { manager: 'npm' }, '--omit=dev', '--include=dev'],
    ['yarn classic', { manager: 'yarn' }, '--production', '--production=false'],
  ] as const;
  const words = (command: string | undefined): string[] => command?.split(' ') ?? [];

  test.each(asked)(
    '%s, a build step: the install asks for dev dependencies, scripts still off',
    (_, over, production, dev) => {
      const [fetch] = installCommands({ ...base, ...over }, PRISMA_STEPS).install.split(' && ');
      expect(words(fetch)).toContain(dev);
      expect(words(fetch)).toContain('--ignore-scripts');
      expect(words(fetch)).not.toContain(production);
    },
  );

  test.each(asked)(
    '%s, a build step: the production install with the dev flag for its own, so the same scripts and rebuild',
    (_, over, production, dev) => {
      const without = installCommands({ ...base, ...over }, []).install;
      expect(words(without).filter((word) => word === production)).toHaveLength(1);
      expect(installCommands({ ...base, ...over }, PRISMA_STEPS).install).toBe(
        without.replace(` ${production} `, ` ${dev} `),
      );
    },
  );

  test.each(asked)(
    '%s: the production install and the prune never take the dev flag',
    (_, over, production, dev) => {
      const without = installCommands({ ...base, ...over }, []);
      expect(words(without.install)).toContain(production);
      expect(words(without.install)).not.toContain(dev);
      expect(words(installCommands({ ...base, ...over }, PRISMA_STEPS).prune)).not.toContain(dev);
    },
  );

  // A pnpm workspace's prune changes what's installed, so pnpm purges the
  // modules directories first and asks; a build has no terminal to answer
  // (pnpm 10 and 11 stop the build, pnpm 9 skips the prune). Whichever pnpm.
  test.each(['pnpm@9.15.9', 'pnpm@10.28.0', 'pnpm@11.28.6', 'pnpm@12.4.2'])(
    'a pnpm workspace on %s, a build step: the prune purges without asking, scripts still off',
    (managerSpec) => {
      const { prune } = installCommands(
        { ...base, manager: 'pnpm', workspace: true, packRel: 'apps/support', managerSpec },
        PRISMA_STEPS,
      );
      expect(prune).toBe(
        `pnpm install --frozen-lockfile --ignore-scripts --prod --config.confirm-modules-purge=false ${member}`,
      );
    },
  );

  // As the image runs it, after buildEnv's NODE_ENV=production: a real npm,
  // offline, from local tarballs, its own config and cache in the test folder.
  test('npm, a build step, NODE_ENV=production: the dev dependency is installed, and the rebuild runs its install script', async () => {
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: root,
      npm_config_cache: join(root, '.npm'),
      npm_config_offline: 'true',
      npm_config_update_notifier: 'false',
    };
    const marker = "node -e \"require('fs').writeFileSync('built', '')\"";
    for (const name of ['dep-a', 'dev-b']) {
      await put(
        `src/${name}/package.json`,
        json({ name, version: '1.0.0', scripts: { install: marker } }),
      );
      execFileSync('npm', ['pack', '--pack-destination', root, '--silent'], {
        cwd: join(root, 'src', name),
        env,
      });
    }
    await put(
      'app/package.json',
      json({
        name: 'app',
        version: '1.0.0',
        private: true,
        dependencies: { 'dep-a': 'file:../dep-a-1.0.0.tgz' },
        devDependencies: { 'dev-b': 'file:../dev-b-1.0.0.tgz' },
      }),
    );
    const app = join(root, 'app');
    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--silent'], {
      cwd: app,
      env,
    });
    const lock = await readFile(join(app, 'package-lock.json'), 'utf8');

    const { install } = installCommands({ ...base, manager: 'npm' }, PRISMA_STEPS);
    execSync(install, { cwd: app, env: { ...env, NODE_ENV: 'production' }, stdio: 'pipe' });

    for (const name of ['dep-a', 'dev-b']) {
      expect(await readFile(join(app, 'node_modules', name, 'built'), 'utf8')).toBe('');
    }
    expect(await readFile(join(app, 'package-lock.json'), 'utf8')).toBe(lock);
  }, 120_000);
});

describe('whyDevDependencies', () => {
  test('build steps: their extensions, each named once', () => {
    const steps = [
      ...PRISMA_STEPS,
      { extension: 'patch-package', bin: 'patch-package' },
      { extension: 'prisma', bin: 'prisma', args: ['validate'] },
    ];
    for (const manager of ['pnpm', 'npm', 'yarn'] as const) {
      expect(whyDevDependencies({ manager, yarnBerry: manager === 'yarn' }, steps)).toBe(
        'for the build steps (prisma, patch-package), whose tools can be dev dependencies',
      );
    }
  });

  test('yarn berry, with no build steps: its production install resolves what yarn.lock lacks', () => {
    expect(whyDevDependencies({ manager: 'yarn', yarnBerry: true }, [])).toBe(
      "since yarn berry's production install resolves what yarn.lock lacks instead of failing",
    );
  });

  test('none: no build steps, and not yarn berry', () => {
    for (const manager of ['pnpm', 'npm', 'yarn'] as const) {
      expect(whyDevDependencies({ manager, yarnBerry: false }, [])).toBeUndefined();
    }
  });
});

describe('installLine', () => {
  test('production dependencies only, or dev ones too and why', () => {
    expect(installLine({ manager: 'npm', yarnBerry: false }, [])).toBe(
      '    ✓ Install: production dependencies only',
    );
    expect(installLine({ manager: 'npm', yarnBerry: false }, PRISMA_STEPS)).toBe(
      '    ✓ Install: dev dependencies too, for the build steps (prisma), whose tools can be dev dependencies; pruned to production after',
    );
  });

  test("'loaded': the cut-down install and how much of the lockfile it keeps, or the full one trimmed after and why", () => {
    const reduced = { written: {}, copied: [], kept: 15, total: 17, leftOut: [] };
    expect(installLine({ manager: 'pnpm', yarnBerry: false, reduced }, [])).toBe(
      "    ✓ Install: only what the pack loads, 15 of the lockfile's 17 packages; production dependencies only",
    );
    expect(
      installLine(
        { manager: 'npm', yarnBerry: false, reduced: { ...reduced, leftOut: ['next', 'react'] } },
        [],
      ),
    ).toBe(
      "    ✓ Install: only what the pack loads, 15 of the lockfile's 17 packages; production dependencies only\n" +
        "      Left out 2 of the pack's own dependencies its tools don't import: next, react",
    );
    expect(installLine({ manager: 'pnpm', yarnBerry: false, reduced }, PRISMA_STEPS)).toBe(
      "    ✓ Install: only what the pack loads, 15 of the lockfile's 17 packages; dev dependencies too, for the build steps (prisma), whose tools can be dev dependencies; pruned to production after",
    );
    expect(
      installLine(
        { manager: 'yarn', yarnBerry: true },
        [],
        "yarn berry's lockfile can't be cut down by hand and still install immutably",
      ),
    ).toBe(
      "    ✓ Install: dev dependencies too, since yarn berry's production install resolves what yarn.lock lacks instead of failing; pruned to production after, then trimmed to what the pack loads\n" +
        "      It downloads the app's whole install first, since yarn berry's lockfile can't be cut down by hand and still install immutably.",
    );
  });
});

describe("the 'loaded' install lines the docs show are installLine's", () => {
  /** The pages that show them, and how many each shows. */
  const PAGES = [
    ['packages/cli/README.md', 2],
    ['site/src/content/docs/start/existing-app-typescript.md', 1],
  ] as const;
  const FIRST =
    /^( *)✓ Install: (only what the pack loads, |.*, then trimmed to what the pack loads$)/;

  /** Each captured line of a 'loaded' install, with every line under it up to the fence, at installLine's indent. */
  function captures(text: string): string[] {
    const lines = text.split('\n');
    const found: string[] = [];
    lines.forEach((line, i) => {
      const indent = FIRST.exec(line)?.[1];
      if (indent === undefined) return;
      const fence = lines.findIndex((l, j) => j > i && l.trim().startsWith('```'));
      expect(fence, `the code block of "${line.trim()}" ends`).toBeGreaterThan(i);
      found.push(
        lines
          .slice(i, fence)
          .map((l) => l.slice(indent.length - 4))
          .join('\n'),
      );
    });
    return found;
  }

  /** What installLine prints for the install the captured lines describe. */
  function printed(capture: string): string {
    const install = { manager: 'pnpm', yarnBerry: false } as const;
    const cut = /only what the pack loads, (\d+) of the lockfile's (\d+) packages;/.exec(capture);
    if (cut !== null) {
      const names = /its tools don't import: (.+)$/m.exec(capture)?.[1];
      const leftOut = names === undefined ? [] : names.split(', ');
      const reduced = {
        written: {},
        copied: [],
        kept: Number(cut[1]),
        total: Number(cut[2]),
        leftOut,
      };
      return installLine({ ...install, reduced }, []);
    }
    // The reducer's own reason for a local package (build-loaded-install.test.ts).
    expect(capture).toMatch(
      /^ +It downloads the app's whole install first, since \S+ is a local package \((link|file|workspace):[^)]+\)\.$/m,
    );
    const reason = /It downloads the app's whole install first, since (.+)\.$/m.exec(capture)?.[1];
    return installLine(install, [], reason);
  }

  test.each(PAGES)('%s', async (page, count) => {
    const text = await readFile(new URL(`../../../${page}`, import.meta.url), 'utf8');
    const shown = captures(text);
    expect(shown).toHaveLength(count);
    for (const capture of shown) expect(capture).toBe(printed(capture));
  });
});

test("the app's own install scripts are listed: every project manifest's, not a local dependency's", async () => {
  await put(
    'package.json',
    json({
      name: 'app',
      workspaces: ['services/*'],
      scripts: { postinstall: 'prisma generate', prepare: 'husky', build: 'next build' },
      dependencies: { '@acme/local': 'file:vendor/local' },
    }),
  );
  await put('package-lock.json', json({ lockfileVersion: 3 }));
  await put(
    'services/api/package.json',
    json({ name: 'api', scripts: { preinstall: 'only-allow npm' } }),
  );
  await put(
    'vendor/local/package.json',
    json({ name: '@acme/local', scripts: { install: 'node build.js' } }),
  );
  const outcome = await resolveHostInstall(root);
  if (outcome.kind !== 'ok') throw new Error(outcome.message);
  expect(outcome.install.skippedScripts).toEqual([
    { manifest: 'package.json', name: 'postinstall', command: 'prisma generate' },
    { manifest: 'package.json', name: 'prepare', command: 'husky' },
    { manifest: 'services/api/package.json', name: 'preinstall', command: 'only-allow npm' },
  ]);
});

describe('withoutInstallScripts', () => {
  test('leaves out the install lifecycle scripts, and keeps every other field and script', () => {
    const text = json({
      name: 'app',
      scripts: {
        preinstall: 'only-allow pnpm',
        postinstall: 'prisma generate',
        prepare: 'husky',
        build: 'next build',
        dev: 'next dev',
      },
      dependencies: { next: '15.0.0' },
    });
    expect(JSON.parse(withoutInstallScripts(text))).toEqual({
      name: 'app',
      scripts: { build: 'next build', dev: 'next dev' },
      dependencies: { next: '15.0.0' },
    });
  });

  test('a manifest with no install scripts comes back byte for byte', () => {
    const text = '{\n    "name": "app",\n    "scripts": { "build": "tsc" }\n}\n';
    expect(withoutInstallScripts(text)).toBe(text);
    expect(withoutInstallScripts('{"name":"app"}')).toBe('{"name":"app"}');
  });
});

describe('skippedScriptLines', () => {
  test('lists the skipped scripts; a warning says how to apply patch-package patches', () => {
    const skipped = [
      {
        manifest: 'package.json',
        name: 'postinstall',
        command: 'prisma generate && patch-package',
      },
      { manifest: 'services/api/package.json', name: 'prepare', command: 'husky' },
    ];
    expect(skippedScriptLines(skipped)).toEqual([
      "    ✓ The app's own install scripts don't run in the image: postinstall (`prisma generate && patch-package`), services/api/package.json prepare (`husky`)",
    ]);
    const warnings = patchPackageWarnings(skipped);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      "    ⚠ postinstall runs patch-package, so its patches aren't applied in the image",
    );
    expect(warnings[0]).toContain("postInstall: [{ bin: 'patch-package' }]");
  });

  test('nothing skipped, nothing said', () => {
    expect(skippedScriptLines([])).toEqual([]);
    expect(patchPackageWarnings([])).toEqual([]);
  });
});

describe('devOnlyImports', () => {
  test("the pack's imports its project lists only in devDependencies", () => {
    expect(
      devOnlyImports(['@acme/db-client', 'zod', 'undeclared'], {
        runtime: ['zod'],
        dev: ['@acme/db-client', 'vitest'],
      }),
    ).toEqual(['@acme/db-client']);
    // Listed in both: the image keeps it.
    expect(devOnlyImports(['zod'], { runtime: ['zod'], dev: ['zod'] })).toEqual([]);
  });
});
