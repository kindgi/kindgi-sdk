// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `image.dependencies: 'loaded'`: the app's install cut down to what the
 * pack loads (`reduceInstall`, `loadedInstall`), and the check that the
 * cut-down lockfile keeps the app's pins (`checkReducedLockfile`), on
 * lockfiles pnpm, npm and yarn 1 wrote (`loaded-install-fixtures.ts`).
 *
 * That the package managers install the cut-down files frozen is checked
 * by hand, with the real tools: these check what the files say.
 */

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';

import { writeContextReal } from '../src/build/defaults.js';
import { resolveHostInstall } from '../src/build/host-install.js';
import type { HostInstall } from '../src/build/host-install.js';
import { checkReducedLockfile } from '../src/build/loaded-install-check.js';
import {
  type HostPackage,
  type LoadedInstallOptions,
  type ReduceInputs,
  findHostPackage,
  loadedInstall,
  reduceInstall,
} from '../src/build/loaded-install.js';
import {
  type LockFixture,
  NPM_WORKSPACE,
  PNPM_ENV,
  PNPM_WORKSPACE,
  YARN_CLASSIC_WORKSPACE,
} from './loaded-install-fixtures.js';

type Json = Record<string, unknown>;

const PATCH_HASH = 'a6ed8e9a2df1dc7919678cd07ff18ff7c2c527d32c76db28fb412a08a85b0f9f';

function host(name: string, version: string, folder: string): HostPackage {
  return { name, version, folder };
}

/** pnpm's virtual store: `node_modules/.pnpm/<folder>/node_modules/<name>`. */
function pnpm(name: string, version: string, folder = `${name}@${version}`): HostPackage {
  return host(name, version, `node_modules/.pnpm/${folder}/node_modules/${name}`);
}

/** What the member `apps/support` loads, as pnpm installed it (supports-color is chalk's, hoisted). */
const PNPM_ROOTS = [
  pnpm('chalk', '4.1.2'),
  pnpm('debug', '4.3.7'),
  pnpm('ms', '2.0.0'),
  pnpm('react-dom', '18.3.1', 'react-dom@18.3.1_react@18.3.1'),
  pnpm('is-number', '7.0.0', `is-number@7.0.0_patch_hash=${PATCH_HASH}`),
  pnpm('supports-color', '7.2.0'),
];

/** The same, as npm installed it: is-number 7.0.0 under the member, the root has 6.0.0. */
const NPM_ROOTS = [
  host('chalk', '4.1.2', 'node_modules/chalk'),
  host('debug', '4.3.7', 'node_modules/debug'),
  host('ms', '2.0.0', 'node_modules/ms'),
  host('react-dom', '18.3.1', 'node_modules/react-dom'),
  host('is-number', '7.0.0', 'apps/support/node_modules/is-number'),
  host('supports-color', '7.2.0', 'node_modules/supports-color'),
];

const YARN_ROOTS = NPM_ROOTS;
const YARN_PEERS = { 'react-dom@18.3.1': [host('react', '18.3.1', 'node_modules/react')] };

function inputs(fixture: LockFixture, more: Partial<ReduceInputs> = {}): ReduceInputs {
  return { ...fixture, roots: [], tools: [], ...more };
}

/**
 * That `outcome` is of `kind`, by assertion: another kind fails the test
 * on this line, showing the outcome (its reason or message), and isn't
 * an error thrown later.
 */
function expectKind<O extends { readonly kind: string }, K extends O['kind']>(
  outcome: O,
  kind: K,
): asserts outcome is Extract<O, { readonly kind: K }> {
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind });
}

/** Cut down, and checked against the app's lockfile: the written files, parsed. */
function reduce(fixture: LockFixture, more: Partial<ReduceInputs> = {}) {
  const outcome = reduceInstall(inputs(fixture, more));
  expectKind(outcome, 'reduced');
  const { reduced } = outcome;
  const lockText = reduced.written[fixture.lockfile.name] ?? '';
  const manifestText = reduced.written['package.json'] ?? '';
  const check = checkReducedLockfile({
    manager: fixture.manager,
    packRel: fixture.packRel,
    lockfile: fixture.lockfile.text,
    reduced: lockText,
    manifest: manifestText,
    rootManifest: fixture.rootManifest,
    packManifest: fixture.packManifest,
  });
  expect(check).toEqual({ kind: 'ok' });
  return { reduced, lockText, manifest: JSON.parse(manifestText) as Json };
}

/** A pnpm lockfile's project document (the last), parsed. */
function pnpmLock(text: string): Json {
  const docs = parseAllDocuments(text);
  expect(Array.isArray(docs), 'a pnpm lockfile is YAML documents').toBe(true);
  const list = Array.isArray(docs) ? docs : [];
  return list[list.length - 1]?.toJS() as Json;
}

function yarnKeys(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith(' ') && !line.startsWith('#'))
    .map((line) => line.replace(/:$/, ''));
}

// ---------------------------------------------------------------------
// pnpm
// ---------------------------------------------------------------------

describe('reduceInstall: pnpm', () => {
  test("a workspace member: its closure, under the importer '.', with the app's entries verbatim", () => {
    const { reduced, lockText, manifest } = reduce(PNPM_WORKSPACE, { roots: PNPM_ROOTS });
    const lock = pnpmLock(lockText);
    const app = pnpmLock(PNPM_WORKSPACE.lockfile.text);
    expect(Object.keys(lock.snapshots as Json).sort()).toEqual([
      'ansi-styles@4.3.0',
      'chalk@4.1.2',
      'color-convert@2.0.1',
      'color-name@1.1.4',
      'debug@4.3.7',
      'has-flag@4.0.0',
      `is-number@7.0.0(patch_hash=${PATCH_HASH})`,
      'js-tokens@4.0.0',
      'loose-envify@1.4.0',
      'ms@2.0.0',
      'ms@2.1.3',
      'react-dom@18.3.1(react@18.3.1)',
      'react@18.3.1',
      'scheduler@0.23.2',
      'supports-color@7.2.0',
    ]);
    for (const section of ['packages', 'snapshots'] as const) {
      for (const [key, entry] of Object.entries(lock[section] as Json)) {
        expect(entry, `${section} ${key}`).toEqual((app[section] as Json)[key]);
      }
    }
    expect(Object.keys(lock.packages as Json)).not.toContain('is-number@6.0.0');
    expect(Object.keys(lock.packages as Json)).not.toContain('left-pad@1.3.0');
    expect(reduced.kept).toBe(15);
    expect(reduced.total).toBe(17);
    // The settings, the catalog and the override stay as the app has them.
    expect(lock.settings).toEqual(app.settings);
    expect(lock.catalogs).toEqual(app.catalogs);
    expect(lock.overrides).toEqual({ 'has-flag': '4.0.0' });
    expect(lock.importers).toEqual({
      '.': {
        dependencies: {
          chalk: { specifier: 'catalog:', version: '4.1.2' },
          debug: { specifier: '4.3.7', version: '4.3.7' },
          'is-number': { specifier: '7.0.0', version: `7.0.0(patch_hash=${PATCH_HASH})` },
          ms: { specifier: '2.0.0', version: '2.0.0' },
          'react-dom': { specifier: '18.3.1', version: '18.3.1(react@18.3.1)' },
          'supports-color': { specifier: '7.2.0', version: '7.2.0' },
        },
      },
    });
    // The importer's specifiers are the cut-down package.json's, catalog: included.
    expect(manifest).toEqual({
      name: 'acme-app',
      private: true,
      packageManager: 'pnpm@10.28.0',
      dependencies: {
        chalk: 'catalog:',
        debug: '4.3.7',
        'is-number': '7.0.0',
        ms: '2.0.0',
        'react-dom': '18.3.1',
        'supports-color': '7.2.0',
      },
    });
    // The workspace file goes along with one project, the cut-down one.
    expect(reduced.written['pnpm-workspace.yaml']).toBe(
      [
        'packages:',
        '  - .',
        '',
        'catalog:',
        '  chalk: ^4.1.2',
        '',
        'overrides:',
        '  has-flag: 4.0.0',
        '',
        'patchedDependencies:',
        '  is-number@7.0.0: patches/is-number@7.0.0.patch',
        '',
        'publicHoistPattern:',
        '  - supports-color',
        '',
      ].join('\n'),
    );
    expect(reduced.copied).toEqual(['apps/support/package.json', 'patches/is-number@7.0.0.patch']);
    // react, which the pack lists, is react-dom's peer: installed.
    expect(reduced.leftOut).toEqual([]);
  });

  test("the pack's own dependencies nothing it loads needs: left out, and said", () => {
    for (const [fixture, chalk] of [
      [PNPM_WORKSPACE, pnpm('chalk', '4.1.2')],
      [NPM_WORKSPACE, host('chalk', '4.1.2', 'node_modules/chalk')],
      [YARN_CLASSIC_WORKSPACE, host('chalk', '4.1.2', 'node_modules/chalk')],
    ] as const) {
      expect(reduce(fixture, { roots: [chalk] }).reduced.leftOut, fixture.manager).toEqual([
        'debug',
        'is-number',
        'ms',
        'react',
        'react-dom',
      ]);
    }
    // At the root, the root's: left-pad is for development only.
    expect(reduce(PNPM_ENV, { roots: [pnpm('chalk', '4.1.2')] }).reduced.leftOut).toEqual([
      'debug',
      'is-number',
      'ms',
      'react',
      'react-dom',
    ]);
  });

  test('a package the pack loads that no importer lists (hoisted): the snapshot its folder names, its version as the specifier', () => {
    const { lockText, manifest } = reduce(PNPM_WORKSPACE, {
      roots: [pnpm('supports-color', '7.2.0')],
    });
    expect((pnpmLock(lockText).importers as Json)['.']).toEqual({
      dependencies: { 'supports-color': { specifier: '7.2.0', version: '7.2.0' } },
    });
    expect(manifest.dependencies).toEqual({ 'supports-color': '7.2.0' });
    expect(Object.keys(pnpmLock(lockText).snapshots as Json).sort()).toEqual([
      'has-flag@4.0.0',
      'supports-color@7.2.0',
    ]);
  });

  test('a patch for a package the pack never loads: left out of the lockfile, the workspace file and the context', () => {
    const { reduced, lockText } = reduce(PNPM_WORKSPACE, { roots: [pnpm('chalk', '4.1.2')] });
    expect(pnpmLock(lockText)).not.toHaveProperty('patchedDependencies');
    expect(parse(reduced.written['pnpm-workspace.yaml'] ?? '')).not.toHaveProperty(
      'patchedDependencies',
    );
    expect(reduced.copied).toEqual(['apps/support/package.json']);
  });

  test("patches in package.json's pnpm field: kept for what the pack loads, with the field's other settings", () => {
    const rootManifest = {
      ...PNPM_WORKSPACE.rootManifest,
      pnpm: {
        overrides: { 'has-flag': '4.0.0' },
        patchedDependencies: { 'is-number@7.0.0': 'patches/is-number@7.0.0.patch' },
      },
    };
    const fixture = { ...PNPM_WORKSPACE, rootManifest };
    const { workspaceText: _, ...noWorkspace } = fixture;
    const loaded = reduce(noWorkspace, { roots: PNPM_ROOTS });
    expect(loaded.manifest.pnpm).toEqual(rootManifest.pnpm);
    expect(loaded.reduced.copied).toEqual([
      'apps/support/package.json',
      'patches/is-number@7.0.0.patch',
    ]);
    const chalkOnly = reduce(noWorkspace, { roots: [pnpm('chalk', '4.1.2')] });
    expect(chalkOnly.manifest.pnpm).toEqual({ overrides: { 'has-flag': '4.0.0' } });
    expect(chalkOnly.reduced.copied).toEqual(['apps/support/package.json']);
  });

  test('the same app twice, the roots in another order: byte-identical files', () => {
    const one = reduceInstall(inputs(PNPM_WORKSPACE, { roots: PNPM_ROOTS }));
    const two = reduceInstall(inputs(PNPM_WORKSPACE, { roots: [...PNPM_ROOTS].reverse() }));
    expect(two).toEqual(one);
    for (const fixture of [NPM_WORKSPACE, YARN_CLASSIC_WORKSPACE]) {
      const a = reduceInstall(inputs(fixture, { roots: NPM_ROOTS, peers: YARN_PEERS }));
      const b = reduceInstall(
        inputs(fixture, { roots: [...NPM_ROOTS].reverse(), peers: YARN_PEERS }),
      );
      expect(b).toEqual(a);
    }
  });

  test("pnpm's env document: kept as it is, before the cut-down project document", () => {
    const debug = pnpm('debug', '4.3.7', 'debug@4.3.7_supports-color@7.2.0');
    const { lockText, reduced } = reduce(PNPM_ENV, { roots: [pnpm('chalk', '4.1.2'), debug] });
    const text = PNPM_ENV.lockfile.text;
    const env = text.slice(0, text.indexOf('\n---\n') + 1);
    expect(lockText.startsWith(`${env}---\nlockfileVersion: '9.0'\n`)).toBe(true);
    expect((pnpmLock(lockText).importers as Json)['.']).toEqual({
      dependencies: {
        chalk: { specifier: '^4.1.2', version: '4.1.2' },
        debug: { specifier: '4.3.7', version: '4.3.7(supports-color@7.2.0)' },
      },
    });
    expect(reduced.copied).toEqual([]);
  });

  test("a build step's tool from devDependencies: a dev dependency of the cut-down install", () => {
    const { manifest, lockText } = reduce(PNPM_WORKSPACE, {
      roots: [pnpm('chalk', '4.1.2')],
      tools: [pnpm('left-pad', '1.3.0')],
    });
    expect(manifest.devDependencies).toEqual({ 'left-pad': '1.3.0' });
    expect((pnpmLock(lockText).importers as Json)['.']).toMatchObject({
      devDependencies: { 'left-pad': { specifier: '1.3.0', version: '1.3.0' } },
    });
  });

  test('every platform an optional native package lists: kept, so the image picks its own', () => {
    const lock = [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  .:',
      '    dependencies:',
      '      native:',
      '        specifier: 1.0.0',
      '        version: 1.0.0',
      '',
      'packages:',
      '',
      "  '@acme/native-darwin-arm64@1.0.0':",
      '    resolution: {integrity: sha512-darwin}',
      '    cpu: [arm64]',
      '    os: [darwin]',
      '',
      "  '@acme/native-linux-x64@1.0.0':",
      '    resolution: {integrity: sha512-linux}',
      '    cpu: [x64]',
      '    os: [linux]',
      '',
      '  native@1.0.0:',
      '    resolution: {integrity: sha512-native}',
      '',
      'snapshots:',
      '',
      "  '@acme/native-darwin-arm64@1.0.0':",
      '    optional: true',
      '',
      "  '@acme/native-linux-x64@1.0.0':",
      '    optional: true',
      '',
      '  native@1.0.0:',
      '    optionalDependencies:',
      "      '@acme/native-darwin-arm64': 1.0.0",
      "      '@acme/native-linux-x64': 1.0.0",
      '',
    ].join('\n');
    const fixture: LockFixture = {
      manager: 'pnpm',
      packRel: '',
      files: ['package.json', 'pnpm-lock.yaml'],
      lockfile: { name: 'pnpm-lock.yaml', text: lock },
      rootManifest: { name: 'acme-app', dependencies: { native: '1.0.0' } },
      packManifest: {},
    };
    const { lockText, reduced } = reduce(fixture, { roots: [pnpm('native', '1.0.0')] });
    expect(pnpmLock(lockText)).toEqual(pnpmLock(lock));
    expect(reduced.kept).toBe(3);
  });

  describe('the same package twice, peers apart', () => {
    const lock = [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  .:',
      '    dependencies:',
      '      a:',
      '        specifier: 1.0.0',
      '        version: 1.0.0',
      '      b:',
      '        specifier: 1.0.0',
      '        version: 1.0.0',
      '',
      'packages:',
      '',
      '  a@1.0.0:',
      '    resolution: {integrity: sha512-a}',
      '',
      '  b@1.0.0:',
      '    resolution: {integrity: sha512-b}',
      '',
      '  p@1.0.0:',
      '    resolution: {integrity: sha512-p1}',
      '',
      '  p@2.0.0:',
      '    resolution: {integrity: sha512-p2}',
      '',
      '  x@1.0.0:',
      '    resolution: {integrity: sha512-x}',
      '    peerDependencies:',
      "      p: '*'",
      '',
      'snapshots:',
      '',
      '  a@1.0.0:',
      '    dependencies:',
      '      p: 1.0.0',
      '      x: 1.0.0(p@1.0.0)',
      '',
      '  b@1.0.0:',
      '    dependencies:',
      '      p: 2.0.0',
      '      x: 1.0.0(p@2.0.0)',
      '',
      '  p@1.0.0: {}',
      '',
      '  p@2.0.0: {}',
      '',
      '  x@1.0.0(p@1.0.0):',
      '    dependencies:',
      '      p: 1.0.0',
      '',
      '  x@1.0.0(p@2.0.0):',
      '    dependencies:',
      '      p: 2.0.0',
      '',
    ].join('\n');
    const fixture: LockFixture = {
      manager: 'pnpm',
      packRel: '',
      files: ['package.json', 'pnpm-lock.yaml'],
      lockfile: { name: 'pnpm-lock.yaml', text: lock },
      rootManifest: { name: 'acme-app', dependencies: { a: '1.0.0', b: '1.0.0' } },
      packManifest: {},
    };

    test('the one whose folder the host has', () => {
      const { lockText } = reduce(fixture, { roots: [pnpm('x', '1.0.0', 'x@1.0.0_p@2.0.0')] });
      const reduced = pnpmLock(lockText);
      expect(Object.keys(reduced.snapshots as Json).sort()).toEqual([
        'p@2.0.0',
        'x@1.0.0(p@2.0.0)',
      ]);
      expect((reduced.importers as Json)['.']).toEqual({
        dependencies: { x: { specifier: '1.0.0', version: '1.0.0(p@2.0.0)' } },
      });
    });

    test("a folder that doesn't say which: the full install", () => {
      expect(
        reduceInstall(inputs(fixture, { roots: [pnpm('x', '1.0.0', 'x@1.0.0_3f2a')] })),
      ).toEqual({
        kind: 'fallback',
        reason: "x 1.0.0 is in the lockfile more than once, and its folder doesn't say which",
      });
    });
  });

  test('a local package among what the pack loads: the full install, and why', () => {
    const text = PNPM_WORKSPACE.lockfile.text.replace(
      "        specifier: 'catalog:'\n        version: 4.1.2",
      "        specifier: 'workspace:*'\n        version: link:../../packages/chalk",
    );
    expect(
      reduceInstall(
        inputs(
          { ...PNPM_WORKSPACE, lockfile: { name: 'pnpm-lock.yaml', text } },
          { roots: PNPM_ROOTS },
        ),
      ),
    ).toEqual({
      kind: 'fallback',
      reason: 'chalk is a local package (link:../../packages/chalk)',
    });
  });

  test("a lockfile version this doesn't cut down, or one it can't parse: the full install, and why", () => {
    const v6 = PNPM_WORKSPACE.lockfile.text.replace(
      "lockfileVersion: '9.0'",
      "lockfileVersion: '6.0'",
    );
    expect(
      reduceInstall(
        inputs(
          { ...PNPM_WORKSPACE, lockfile: { name: 'pnpm-lock.yaml', text: v6 } },
          { roots: PNPM_ROOTS },
        ),
      ),
    ).toEqual({
      kind: 'fallback',
      reason: `pnpm-lock.yaml is lockfileVersion "6.0", and kindgi build cuts down only '9.0'`,
    });
    const three = `---\na: 1\n---\nb: 1\n---\n${PNPM_WORKSPACE.lockfile.text}`;
    expect(
      reduceInstall(
        inputs(
          { ...PNPM_WORKSPACE, lockfile: { name: 'pnpm-lock.yaml', text: three } },
          { roots: PNPM_ROOTS },
        ),
      ),
    ).toEqual({
      kind: 'fallback',
      reason: 'pnpm-lock.yaml has more YAML documents than kindgi build knows',
    });
  });

  test('a package installed outside the project: the full install, and why', () => {
    expect(
      reduceInstall(
        inputs(PNPM_WORKSPACE, { roots: [host('chalk', '4.1.2', '../shared/node_modules/chalk')] }),
      ),
    ).toEqual({
      kind: 'fallback',
      reason: 'chalk is installed outside the project (../shared/node_modules/chalk)',
    });
  });

  test('node_modules out of date with the lockfile: refused, with the package, its folder and the fix', () => {
    expect(
      reduceInstall(
        inputs(PNPM_WORKSPACE, { roots: [pnpm('react-dom', '18.2.0', 'react-dom@18.2.0')] }),
      ),
    ).toEqual({
      kind: 'err',
      message:
        "react-dom is installed at node_modules/.pnpm/react-dom@18.2.0/node_modules/react-dom (18.2.0), but pnpm-lock.yaml pins 18.3.1: node_modules is out of date with the lockfile, so the build would use code the lockfile doesn't pin. Run pnpm install, then kindgi build again.",
    });
    expect(reduceInstall(inputs(PNPM_WORKSPACE, { roots: [pnpm('acme-utils', '1.0.0')] }))).toEqual(
      {
        kind: 'err',
        message:
          "acme-utils is installed at node_modules/.pnpm/acme-utils@1.0.0/node_modules/acme-utils (1.0.0), but pnpm-lock.yaml has no acme-utils 1.0.0: node_modules is out of date with the lockfile, so the build would use code the lockfile doesn't pin. Run pnpm install, then kindgi build again.",
      },
    );
  });

  test('a package the pack loads that its manifest lists only for development: refused', () => {
    expect(reduceInstall(inputs(PNPM_WORKSPACE, { roots: [pnpm('left-pad', '1.3.0')] }))).toEqual({
      kind: 'err',
      message:
        "The pack loads left-pad, which apps/support/package.json lists only in devDependencies. The image keeps production dependencies only, so it wouldn't load there: move it to dependencies.",
    });
  });
});

// ---------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------

describe('reduceInstall: npm', () => {
  test("a workspace member: its closure, the member's own packages moved to the root's node_modules", () => {
    const { reduced, lockText, manifest } = reduce(NPM_WORKSPACE, { roots: NPM_ROOTS });
    const lock = JSON.parse(lockText) as Json;
    const app = JSON.parse(NPM_WORKSPACE.lockfile.text) as { packages: Json };
    const packages = lock.packages as Json;
    expect(Object.keys(packages)).toEqual([
      '',
      'node_modules/ansi-styles',
      'node_modules/chalk',
      'node_modules/color-convert',
      'node_modules/color-name',
      'node_modules/debug',
      'node_modules/debug/node_modules/ms',
      'node_modules/has-flag',
      'node_modules/is-number',
      'node_modules/js-tokens',
      'node_modules/loose-envify',
      'node_modules/ms',
      'node_modules/react',
      'node_modules/react-dom',
      'node_modules/scheduler',
      'node_modules/supports-color',
    ]);
    // The member's is-number 7.0.0, not the root's 6.0.0.
    expect(packages['node_modules/is-number']).toEqual(
      app.packages['apps/support/node_modules/is-number'],
    );
    expect(packages['node_modules/debug/node_modules/ms']).toEqual(
      app.packages['node_modules/debug/node_modules/ms'],
    );
    expect(lock.name).toBe('acme-app');
    expect(lock.lockfileVersion).toBe(3);
    expect(packages['']).toEqual({ name: 'acme-app', dependencies: manifest.dependencies });
    expect(manifest).toEqual({
      name: 'acme-app',
      private: true,
      dependencies: {
        chalk: '^4.1.2',
        debug: '4.3.7',
        'is-number': '7.0.0',
        ms: '2.0.0',
        'react-dom': '18.3.1',
        'supports-color': '7.2.0',
      },
    });
    expect(reduced.kept).toBe(15);
    expect(reduced.total).toBe(17);
    expect(reduced.copied).toEqual(['apps/support/package.json']);
  });

  test("a build step's tool from devDependencies: flagged dev, so the production prune drops it", () => {
    const { lockText, manifest } = reduce(NPM_WORKSPACE, {
      roots: [host('chalk', '4.1.2', 'node_modules/chalk')],
      tools: [host('left-pad', '1.3.0', 'node_modules/left-pad')],
    });
    const packages = (JSON.parse(lockText) as { packages: Json }).packages;
    expect(packages['node_modules/left-pad']).toMatchObject({ version: '1.3.0', dev: true });
    expect(packages['node_modules/chalk']).not.toHaveProperty('dev');
    expect(manifest.devDependencies).toEqual({ 'left-pad': '1.3.0' });
  });

  test("lockfileVersion 2: the cut-down lockfile has packages only, not npm 6's tree", () => {
    const v2 = {
      ...JSON.parse(NPM_WORKSPACE.lockfile.text),
      lockfileVersion: 2,
      dependencies: { chalk: { version: '4.1.2' } },
    };
    const fixture = {
      ...NPM_WORKSPACE,
      lockfile: { name: 'package-lock.json', text: JSON.stringify(v2, null, 2) },
    };
    const lock = JSON.parse(reduce(fixture, { roots: NPM_ROOTS }).lockText) as Json;
    expect(lock.lockfileVersion).toBe(2);
    expect(lock).not.toHaveProperty('dependencies');
  });

  test('optional platform packages: every one the lockfile has, the missing ones left missing', () => {
    const lock = {
      name: 'acme-app',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'acme-app', dependencies: { native: '1.0.0' } },
        'node_modules/native': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/native/-/native-1.0.0.tgz',
          integrity: 'sha512-native',
          optionalDependencies: {
            '@acme/native-darwin-arm64': '1.0.0',
            '@acme/native-linux-x64': '1.0.0',
            '@acme/native-win32-x64': '1.0.0',
          },
        },
        'node_modules/@acme/native-darwin-arm64': {
          version: '1.0.0',
          optional: true,
          os: ['darwin'],
          cpu: ['arm64'],
        },
        'node_modules/@acme/native-linux-x64': {
          version: '1.0.0',
          optional: true,
          os: ['linux'],
          cpu: ['x64'],
        },
      },
    };
    const fixture: LockFixture = {
      manager: 'npm',
      packRel: '',
      files: ['package.json', 'package-lock.json'],
      lockfile: { name: 'package-lock.json', text: JSON.stringify(lock, null, 2) },
      rootManifest: { name: 'acme-app', dependencies: { native: '1.0.0' } },
      packManifest: {},
    };
    const { lockText } = reduce(fixture, {
      roots: [host('native', '1.0.0', 'node_modules/native')],
    });
    expect(JSON.parse(lockText)).toEqual(lock);
  });

  test("the pack's package and the root's under one name: the full install, and why", () => {
    const app = JSON.parse(NPM_WORKSPACE.lockfile.text) as { packages: Record<string, Json> };
    const chalk = app.packages['node_modules/chalk'] as Json;
    app.packages['node_modules/chalk'] = {
      ...chalk,
      dependencies: { ...(chalk.dependencies as Json), 'is-number': '6.0.0' },
    };
    const fixture = {
      ...NPM_WORKSPACE,
      lockfile: { name: 'package-lock.json', text: JSON.stringify(app) },
    };
    const outcome = reduceInstall(inputs(fixture, { roots: NPM_ROOTS }));
    expect(outcome.kind).toBe('fallback');
    expect(outcome).toMatchObject({
      reason: expect.stringMatching(
        /^is-number is installed twice for the pack \(.*node_modules\/is-number and .*node_modules\/is-number\)$/,
      ),
    });
  });

  test("a dependency the lockfile doesn't have, a workspace link, an old lockfile: the full install, and why", () => {
    const app = JSON.parse(NPM_WORKSPACE.lockfile.text) as { packages: Json };
    const { 'node_modules/color-name': _, ...packages } = app.packages;
    const missing = {
      ...NPM_WORKSPACE,
      lockfile: { name: 'package-lock.json', text: JSON.stringify({ ...app, packages }) },
    };
    expect(reduceInstall(inputs(missing, { roots: NPM_ROOTS }))).toEqual({
      kind: 'fallback',
      reason: 'package-lock.json has no color-name for node_modules/color-convert',
    });
    expect(
      reduceInstall(
        inputs(NPM_WORKSPACE, {
          roots: [host('@acme/support', '0.1.0', 'node_modules/@acme/support')],
        }),
      ),
    ).toEqual({
      kind: 'fallback',
      reason: '@acme/support is a local package (apps/support)',
    });
    const v1 = {
      ...NPM_WORKSPACE,
      lockfile: { name: 'package-lock.json', text: JSON.stringify({ lockfileVersion: 1 }) },
    };
    expect(reduceInstall(inputs(v1, { roots: NPM_ROOTS }))).toEqual({
      kind: 'fallback',
      reason: 'package-lock.json is lockfileVersion 1, and kindgi build cuts down only 2 and 3',
    });
  });

  test('node_modules out of date with the lockfile: refused, with the fix', () => {
    expect(
      reduceInstall(
        inputs(NPM_WORKSPACE, { roots: [host('react-dom', '18.2.0', 'node_modules/react-dom')] }),
      ),
    ).toEqual({
      kind: 'err',
      message:
        "react-dom is installed at node_modules/react-dom (18.2.0), but package-lock.json pins 18.3.1: node_modules is out of date with the lockfile, so the build would use code the lockfile doesn't pin. Run npm ci, then kindgi build again.",
    });
  });
});

// ---------------------------------------------------------------------
// yarn 1
// ---------------------------------------------------------------------

describe('reduceInstall: yarn 1', () => {
  test("a workspace member: its blocks verbatim, and a peer the app's production install has as a dependency of its own", () => {
    const { reduced, lockText, manifest } = reduce(YARN_CLASSIC_WORKSPACE, {
      roots: YARN_ROOTS,
      peers: YARN_PEERS,
    });
    expect(
      lockText.startsWith(
        '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n\n\n',
      ),
    ).toBe(true);
    expect(yarnKeys(lockText)).toEqual([
      'ansi-styles@^4.1.0',
      'chalk@^4.1.2',
      'color-convert@^2.0.1',
      'color-name@~1.1.4',
      'debug@4.3.7',
      'has-flag@^4.0.0',
      'is-number@7.0.0',
      '"js-tokens@^3.0.0 || ^4.0.0"',
      'loose-envify@^1.1.0',
      'ms@2.0.0',
      'ms@^2.1.3',
      'react-dom@18.3.1',
      'react@18.3.1',
      'scheduler@^0.23.2',
      'supports-color@^7.1.0',
    ]);
    expect(manifest).toEqual({
      name: 'acme-app',
      private: true,
      packageManager: 'yarn@1.22.22',
      dependencies: {
        chalk: '^4.1.2',
        debug: '4.3.7',
        'is-number': '7.0.0',
        ms: '2.0.0',
        react: '18.3.1',
        'react-dom': '18.3.1',
        // chalk's, hoisted: the range its block has.
        'supports-color': '^7.1.0',
      },
    });
    expect(reduced.kept).toBe(15);
    expect(reduced.total).toBe(17);
  });

  test("without the host's peers, a peer isn't installed: yarn 1 installs only what the manifest reaches", () => {
    const { lockText, manifest } = reduce(YARN_CLASSIC_WORKSPACE, {
      roots: [host('react-dom', '18.3.1', 'node_modules/react-dom')],
    });
    expect(manifest.dependencies).toEqual({ 'react-dom': '18.3.1' });
    expect(yarnKeys(lockText)).not.toContain('react@18.3.1');
  });

  test("a peer only the app's development has: not added", () => {
    const { manifest } = reduce(YARN_CLASSIC_WORKSPACE, {
      roots: [host('chalk', '4.1.2', 'node_modules/chalk')],
      peers: { 'chalk@4.1.2': [host('left-pad', '1.3.0', 'node_modules/left-pad')] },
    });
    expect(manifest.dependencies).toEqual({ chalk: '^4.1.2' });
  });

  test('node_modules or the lockfile out of date: refused, with the fix', () => {
    expect(
      reduceInstall(
        inputs(YARN_CLASSIC_WORKSPACE, { roots: [host('chalk', '4.1.0', 'node_modules/chalk')] }),
      ),
    ).toEqual({
      kind: 'err',
      message:
        "chalk is installed at node_modules/chalk (4.1.0), but yarn.lock has no chalk 4.1.0: node_modules is out of date with the lockfile, so the build would use code the lockfile doesn't pin. Run yarn install, then kindgi build again.",
    });
    const packManifest = {
      ...YARN_CLASSIC_WORKSPACE.packManifest,
      dependencies: { chalk: '^4.1.0' },
    };
    expect(
      reduceInstall(
        inputs(
          { ...YARN_CLASSIC_WORKSPACE, packManifest },
          { roots: [host('chalk', '4.1.2', 'node_modules/chalk')] },
        ),
      ),
    ).toEqual({
      kind: 'err',
      message:
        'apps/support/package.json lists chalk@^4.1.0, and yarn.lock has no entry for it: the lockfile is out of date with it. Run yarn install, then kindgi build again.',
    });
  });

  test("a local package, or a lockfile that isn't yarn 1's: the full install, and why", () => {
    const text = YARN_CLASSIC_WORKSPACE.lockfile.text.replace(
      /resolved "https:\/\/registry\.yarnpkg\.com\/chalk\/[^"]+"/,
      'resolved "file:../vendor/chalk"',
    );
    expect(text).not.toBe(YARN_CLASSIC_WORKSPACE.lockfile.text);
    expect(
      reduceInstall(
        inputs(
          { ...YARN_CLASSIC_WORKSPACE, lockfile: { name: 'yarn.lock', text } },
          { roots: YARN_ROOTS },
        ),
      ),
    ).toEqual({
      kind: 'fallback',
      reason: 'chalk is a local package (file:../vendor/chalk)',
    });
    expect(
      reduceInstall(
        inputs(
          {
            ...YARN_CLASSIC_WORKSPACE,
            lockfile: { name: 'yarn.lock', text: 'chalk@^4.1.2:\n  version "4.1.2"\n' },
          },
          { roots: YARN_ROOTS },
        ),
      ),
    ).toEqual({
      kind: 'fallback',
      reason: "yarn.lock isn't a yarn 1 lockfile kindgi build knows",
    });
  });
});

// ---------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------

describe('checkReducedLockfile', () => {
  /** The check on a cut-down install changed by `change`: what it says. */
  function checkChanged(
    fixture: LockFixture,
    more: Partial<ReduceInputs>,
    change: (files: { lock: string; manifest: string }) => { lock: string; manifest: string },
  ) {
    const outcome = reduceInstall(inputs(fixture, more));
    expectKind(outcome, 'reduced');
    const files = change({
      lock: outcome.reduced.written[fixture.lockfile.name] ?? '',
      manifest: outcome.reduced.written['package.json'] ?? '',
    });
    return checkReducedLockfile({
      manager: fixture.manager,
      packRel: fixture.packRel,
      lockfile: fixture.lockfile.text,
      reduced: files.lock,
      manifest: files.manifest,
      rootManifest: fixture.rootManifest,
      packManifest: fixture.packManifest,
    });
  }
  const swap = (from: string | RegExp, to: string) => (text: string) => {
    const changed = text.replace(from, to);
    expect(changed, `${String(from)} in the cut-down file`).not.toBe(text);
    return changed;
  };
  const lockOnly =
    (f: (text: string) => string) => (files: { lock: string; manifest: string }) => ({
      ...files,
      lock: f(files.lock),
    });
  const manifestOnly =
    (f: (manifest: Json) => Json) => (files: { lock: string; manifest: string }) => ({
      ...files,
      manifest: JSON.stringify(f(JSON.parse(files.manifest) as Json)),
    });

  test('pnpm: a changed integrity, an entry the app lacks, a changed setting or env document, a second importer', () => {
    const pnpmRoots = { roots: PNPM_ROOTS };
    expect(
      checkChanged(
        PNPM_WORKSPACE,
        pnpmRoots,
        lockOnly(swap('sha512-6FlzubTLZG', 'sha512-0000000000')),
      ),
    ).toEqual({
      kind: 'refused',
      message: "packages ms@2.1.3 differs from the app's",
    });
    expect(
      checkChanged(
        PNPM_WORKSPACE,
        pnpmRoots,
        lockOnly(
          swap(
            '\nsnapshots:\n',
            '\n  evil@1.0.0:\n    resolution: {integrity: sha512-evil}\n\nsnapshots:\n',
          ),
        ),
      ),
    ).toEqual({
      kind: 'refused',
      message: "packages has evil@1.0.0, which the app's lockfile doesn't",
    });
    expect(
      checkChanged(PNPM_WORKSPACE, pnpmRoots, lockOnly(swap('      ms: 2.1.3', '      ms: 2.0.0'))),
    ).toEqual({
      kind: 'refused',
      message: "snapshots debug@4.3.7 differs from the app's",
    });
    expect(
      checkChanged(
        PNPM_WORKSPACE,
        pnpmRoots,
        lockOnly(swap('autoInstallPeers: true', 'autoInstallPeers: false')),
      ),
    ).toEqual({
      kind: 'refused',
      message: "its settings differs from the app's",
    });
    expect(
      checkChanged(
        PNPM_WORKSPACE,
        pnpmRoots,
        lockOnly(swap('  has-flag: 4.0.0\n', '  has-flag: 5.0.0\n')),
      ),
    ).toEqual({
      kind: 'refused',
      message: "its overrides differs from the app's",
    });
    expect(
      checkChanged(
        PNPM_WORKSPACE,
        pnpmRoots,
        lockOnly(swap('\npackages:\n', '\n  apps/support:\n    dependencies: {}\n\npackages:\n')),
      ),
    ).toEqual({
      kind: 'refused',
      message: 'it has importer apps/support, and the image installs one project',
    });
    expect(
      checkChanged(
        PNPM_ENV,
        { roots: [pnpm('chalk', '4.1.2')] },
        lockOnly(swap('os: [darwin]', 'os: [linux]')),
      ),
    ).toEqual({
      kind: 'refused',
      message: 'the env document differs',
    });
  });

  test("pnpm: an importer the cut-down package.json doesn't match, a dev package installed for production", () => {
    const pnpmRoots = { roots: PNPM_ROOTS };
    expect(
      checkChanged(
        PNPM_WORKSPACE,
        pnpmRoots,
        manifestOnly((m) => ({ ...m, dependencies: { ...(m.dependencies as Json), chalk: '^4' } })),
      ),
    ).toEqual({
      kind: 'refused',
      message: "chalk's specifier isn't the cut-down package.json's",
    });
    expect(
      checkChanged(
        PNPM_WORKSPACE,
        pnpmRoots,
        manifestOnly((m) => ({
          ...m,
          dependencies: { ...(m.dependencies as Json), 'acme-extra': '1.0.0' },
        })),
      ),
    ).toEqual({
      kind: 'refused',
      message: "the cut-down package.json has acme-extra, which its lockfile doesn't",
    });
    const devAsProd = checkChanged(
      PNPM_WORKSPACE,
      { roots: [pnpm('chalk', '4.1.2')], tools: [pnpm('left-pad', '1.3.0')] },
      (files) => ({
        lock: swap('    devDependencies:\n', '    optionalDependencies:\n')(files.lock),
        manifest: JSON.stringify({
          ...(JSON.parse(files.manifest) as Json),
          devDependencies: undefined,
          optionalDependencies: { 'left-pad': '1.3.0' },
        }),
      }),
    );
    expect(devAsProd).toEqual({
      kind: 'refused',
      message: "left-pad@1.3.0 isn't in the app's production dependencies",
    });
  });

  test('npm: a changed entry, one the app lacks, a dev package installed for production, a root unlike the manifest', () => {
    const npmRoots = { roots: NPM_ROOTS };
    const edit = (f: (lock: { packages: Record<string, Json>; [k: string]: unknown }) => void) =>
      lockOnly((text) => {
        const lock = JSON.parse(text);
        f(lock);
        return JSON.stringify(lock);
      });
    expect(
      checkChanged(
        NPM_WORKSPACE,
        npmRoots,
        edit((l) => {
          (l.packages['node_modules/chalk'] as Json).resolved =
            'https://registry.example/chalk-4.1.2.tgz';
        }),
      ),
    ).toEqual({
      kind: 'refused',
      message: "node_modules/chalk differs from the app's",
    });
    expect(
      checkChanged(
        NPM_WORKSPACE,
        npmRoots,
        edit((l) => {
          l.packages['node_modules/evil'] = { version: '1.0.0' };
        }),
      ),
    ).toEqual({
      kind: 'refused',
      message: "it has node_modules/evil, which the app's lockfile doesn't",
    });
    expect(
      checkChanged(
        NPM_WORKSPACE,
        npmRoots,
        edit((l) => {
          l.lockfileVersion = 2;
        }),
      ),
    ).toEqual({
      kind: 'refused',
      message: 'its lockfileVersion differs',
    });
    expect(
      checkChanged(
        NPM_WORKSPACE,
        {
          roots: [host('chalk', '4.1.2', 'node_modules/chalk')],
          tools: [host('left-pad', '1.3.0', 'node_modules/left-pad')],
        },
        edit((l) => {
          const { dev: _, ...leftPad } = l.packages['node_modules/left-pad'] as Json;
          l.packages['node_modules/left-pad'] = leftPad;
        }),
      ),
    ).toEqual({
      kind: 'refused',
      message: 'node_modules/left-pad is only a dev dependency of the app',
    });
    expect(
      checkChanged(
        NPM_WORKSPACE,
        npmRoots,
        manifestOnly((m) => ({ ...m, dependencies: { ...(m.dependencies as Json), chalk: '^4' } })),
      ),
    ).toEqual({
      kind: 'refused',
      message: "its dependencies aren't the cut-down package.json's",
    });
  });

  test('yarn 1: a changed block, one the app lacks, a manifest entry the lockfile lacks, a dev package installed for production', () => {
    const yarnRoots = { roots: YARN_ROOTS, peers: YARN_PEERS };
    expect(
      checkChanged(
        YARN_CLASSIC_WORKSPACE,
        yarnRoots,
        lockOnly(swap(/integrity sha512-oKnbhFyRIX/, 'integrity sha512-0000000000')),
      ),
    ).toEqual({
      kind: 'refused',
      message: "chalk@^4.1.2 differs from the app's",
    });
    expect(
      checkChanged(
        YARN_CLASSIC_WORKSPACE,
        yarnRoots,
        lockOnly((text) => `${text}\nevil@1.0.0:\n  version "1.0.0"\n`),
      ),
    ).toEqual({
      kind: 'refused',
      message: "it has evil@1.0.0, which the app's lockfile doesn't",
    });
    expect(
      checkChanged(
        YARN_CLASSIC_WORKSPACE,
        yarnRoots,
        manifestOnly((m) => ({ ...m, dependencies: { ...(m.dependencies as Json), chalk: '^4' } })),
      ),
    ).toEqual({
      kind: 'refused',
      message: "the cut-down package.json has chalk@^4, which its lockfile doesn't",
    });
    const leftPad =
      YARN_CLASSIC_WORKSPACE.lockfile.text.match(/\nleft-pad@1\.3\.0:\n(?: {2}.*\n)+/)?.[0] ?? '';
    expect(leftPad).not.toBe('');
    const devAsProd = checkChanged(YARN_CLASSIC_WORKSPACE, yarnRoots, (files) => ({
      lock: `${files.lock}${leftPad}`,
      manifest: JSON.stringify({
        ...(JSON.parse(files.manifest) as Json),
        dependencies: {
          ...(JSON.parse(files.manifest) as { dependencies: Json }).dependencies,
          'left-pad': '1.3.0',
        },
      }),
    }));
    expect(devAsProd).toEqual({
      kind: 'refused',
      message: "left-pad@1.3.0 isn't in the app's production dependencies",
    });
  });
});

// ---------------------------------------------------------------------
// The host: loadedInstall, findHostPackage
// ---------------------------------------------------------------------

describe('loadedInstall', () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'kindgi-loaded-install-')));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function put(rel: string, content: string | Json): Promise<void> {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(
      join(root, rel),
      typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`,
    );
  }

  const entry = (name: string, more: Json = {}): Json => ({
    version: '1.0.0',
    resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
    integrity: `sha512-${name}`,
    ...more,
  });

  /** An npm app: `a` (which needs `b`) and `c` for production, `tool` (bin `tool`) for development. */
  async function npmApp(): Promise<HostInstall> {
    await put('package.json', {
      name: 'acme-app',
      private: true,
      dependencies: { a: '1.0.0', c: '1.0.0' },
      devDependencies: { tool: '1.0.0' },
    });
    await put('package-lock.json', {
      name: 'acme-app',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'acme-app',
          dependencies: { a: '1.0.0', c: '1.0.0' },
          devDependencies: { tool: '1.0.0' },
        },
        'node_modules/a': entry('a', { dependencies: { b: '^1.0.0' } }),
        'node_modules/b': entry('b'),
        'node_modules/c': entry('c'),
        'node_modules/tool': entry('tool', { dev: true, bin: { tool: 'cli.js' } }),
      },
    });
    for (const name of ['a', 'b', 'c'])
      await put(`node_modules/${name}/package.json`, { name, version: '1.0.0' });
    await put('node_modules/tool/package.json', {
      name: 'tool',
      version: '1.0.0',
      bin: { tool: 'cli.js' },
    });
    const outcome = await resolveHostInstall(root);
    expectKind(outcome, 'ok');
    return outcome.install;
  }

  function options(
    install: HostInstall,
    more: Omit<Partial<LoadedInstallOptions>, 'image'> & {
      image?: Partial<LoadedInstallOptions['image']>;
    } = {},
  ): LoadedInstallOptions {
    return {
      install,
      packDir: root,
      externals: ['a'],
      ...more,
      image: { keep: [], keepIfInstalled: [], steps: [], ...more.image },
    };
  }

  test("what the pack loads, found as Node finds it, cut down and checked: one project, the cut-down files the context's", async () => {
    const install = await npmApp();
    const outcome = await loadedInstall(options(install));
    expectKind(outcome, 'reduced');
    expect(outcome.install.workspace).toBe(false);
    expect(outcome.install.files).toEqual(['package-lock.json', 'package.json']);
    expect(outcome.install.projectManifests).toEqual([]);
    expect(outcome.install.reduced?.kept).toBe(2);
    expect(outcome.install.reduced?.total).toBe(4);
    expect(JSON.parse(outcome.install.reduced?.written['package.json'] ?? '')).toEqual({
      name: 'acme-app',
      private: true,
      dependencies: { a: '1.0.0' },
    });
  });

  test("image.keep and the installed keepIfInstalled join what the bundles import; a folder a step writes doesn't", async () => {
    const install = await npmApp();
    const outcome = await loadedInstall(
      options(install, {
        externals: [],
        image: { keep: ['a', '.prisma/client'], keepIfInstalled: ['c', 'not-installed'] },
      }),
    );
    expectKind(outcome, 'reduced');
    expect(JSON.parse(outcome.install.reduced?.written['package.json'] ?? '').dependencies).toEqual(
      { a: '1.0.0', c: '1.0.0' },
    );
  });

  test("a build step's tool: the dependency whose bin it runs, as a dev dependency; none: the full install", async () => {
    const install = await npmApp();
    const step = (bin: string) => ({ extension: 'acme', bin, args: [] });
    const outcome = await loadedInstall(options(install, { image: { steps: [step('tool')] } }));
    expectKind(outcome, 'reduced');
    expect(
      JSON.parse(outcome.install.reduced?.written['package.json'] ?? '').devDependencies,
    ).toEqual({ tool: '1.0.0' });
    expect(await loadedInstall(options(install, { image: { steps: [step('generate')] } }))).toEqual(
      {
        kind: 'fallback',
        reason: "no dependency of the pack has the build step's generate",
      },
    );
  });

  test("a package the pack loads that Node doesn't find from the pack folder: refused, with where to add it", async () => {
    const install = await npmApp();
    expect(await loadedInstall(options(install, { externals: ['missing'] }))).toEqual({
      kind: 'err',
      message: `The pack loads missing, but Node doesn't find it from ${root}, where the image loads it from: add it to the dependencies of ${join(root, 'package.json')}, run npm ci, then kindgi build again.`,
    });
  });

  test('node_modules out of date with the lockfile: refused', async () => {
    const install = await npmApp();
    await put('node_modules/a/package.json', { name: 'a', version: '1.0.1' });
    expect(await loadedInstall(options(install))).toMatchObject({
      kind: 'err',
      message: expect.stringContaining(
        'a is installed at node_modules/a (1.0.1), but package-lock.json pins 1.0.0',
      ),
    });
  });

  test('yarn berry: the full install, and why', async () => {
    const install = await npmApp();
    expect(await loadedInstall(options({ ...install, manager: 'yarn', yarnBerry: true }))).toEqual({
      kind: 'fallback',
      reason: "yarn berry's lockfile can't be cut down by hand and still install immutably",
    });
  });

  test("yarn 1: the installed packages' peers, found from each one's folder", async () => {
    await put('package.json', {
      name: 'acme-app',
      private: true,
      dependencies: { 'react-dom': '18.3.1', react: '18.3.1' },
    });
    await put(
      'yarn.lock',
      [
        '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.',
        '# yarn lockfile v1',
        '',
        '',
        'react-dom@18.3.1:',
        '  version "18.3.1"',
        '  resolved "https://registry.yarnpkg.com/react-dom/-/react-dom-18.3.1.tgz#c2265d79511b57d479b3dd3fdfa51536494c5cb4"',
        '  integrity sha512-react-dom',
        '',
        'react@18.3.1:',
        '  version "18.3.1"',
        '  resolved "https://registry.yarnpkg.com/react/-/react-18.3.1.tgz#49ab892009c53933625bd16b2533fc754cab2891"',
        '  integrity sha512-react',
        '',
      ].join('\n'),
    );
    await put('node_modules/react-dom/package.json', {
      name: 'react-dom',
      version: '18.3.1',
      peerDependencies: { react: '^18.3.1' },
    });
    await put('node_modules/react/package.json', { name: 'react', version: '18.3.1' });
    const resolved = await resolveHostInstall(root);
    expectKind(resolved, 'ok');
    const outcome = await loadedInstall(options(resolved.install, { externals: ['react-dom'] }));
    expectKind(outcome, 'reduced');
    expect(JSON.parse(outcome.install.reduced?.written['package.json'] ?? '').dependencies).toEqual(
      {
        react: '18.3.1',
        'react-dom': '18.3.1',
      },
    );
  });
});

describe('writeContext, with a cut-down install', () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'kindgi-loaded-context-')));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("the cut-down files kindgi build wrote, and the app's it still reads: nothing else of the app's install", async () => {
    const app = join(root, 'app');
    const files: Record<string, string> = {
      'package.json':
        '{"name":"acme-app","scripts":{"postinstall":"husky"},"dependencies":{"next":"15.0.0"}}\n',
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n# the app's\n",
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
      'apps/support/package.json':
        '{"name":"@acme/support","scripts":{"prepare":"husky"},"dependencies":{"chalk":"^4.1.2"}}\n',
      'patches/chalk@4.1.2.patch': 'diff\n',
      'patches/next@15.0.0.patch': 'diff\n',
    };
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(app, rel)), { recursive: true });
      await writeFile(join(app, rel), text);
    }
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(join(root, 'Containerfile'), '# fake\n');
    const written = {
      'package.json': '{"name":"acme-app","private":true,"dependencies":{"chalk":"^4.1.2"}}\n',
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n# cut down\n",
    };
    const copied = ['apps/support/package.json', 'patches/chalk@4.1.2.patch'];
    const install: HostInstall = {
      root: app,
      packRel: 'apps/support',
      manager: 'pnpm',
      yarnBerry: false,
      workspace: false,
      files: [...Object.keys(written), ...copied].sort(),
      projectManifests: ['apps/support/package.json'],
      skippedScripts: [],
      packDependencies: { runtime: ['chalk'], dev: [] },
      secrets: [],
      reduced: { written, copied, kept: 6, total: 400, leftOut: [] },
    };
    const contextDir = join(root, 'context');
    await writeContextReal({
      contextDir,
      packDir: join(app, 'apps/support'),
      install,
      bundleDir: join(root, 'dist'),
      containerfilePath: join(root, 'Containerfile'),
      includes: [],
      extensionFiles: [],
      blockFiles: [],
    });
    const host = join(contextDir, 'host');
    expect(await readFile(join(host, 'package.json'), 'utf8')).toBe(written['package.json']);
    expect(await readFile(join(host, 'pnpm-lock.yaml'), 'utf8')).toBe(written['pnpm-lock.yaml']);
    expect(await readFile(join(host, 'patches/chalk@4.1.2.patch'), 'utf8')).toBe('diff\n');
    // The pack's own manifest, without its install scripts.
    expect(JSON.parse(await readFile(join(host, 'apps/support/package.json'), 'utf8'))).toEqual({
      name: '@acme/support',
      scripts: {},
      dependencies: { chalk: '^4.1.2' },
    });
    expect((await readdir(host)).sort()).toEqual([
      'apps',
      'package.json',
      'patches',
      'pnpm-lock.yaml',
    ]);
    expect(await readdir(join(host, 'patches'))).toEqual(['chalk@4.1.2.patch']);
  });
});

describe('findHostPackage', () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'kindgi-host-package-')));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('where Node finds it from the pack folder, up to the install root: the nearest, by its real folder', async () => {
    await mkdir(join(root, 'apps/support/node_modules/is-number'), { recursive: true });
    await writeFile(
      join(root, 'apps/support/node_modules/is-number/package.json'),
      '{"name":"is-number","version":"7.0.0"}',
    );
    await mkdir(join(root, 'node_modules/.pnpm/chalk@4.1.2/node_modules/chalk'), {
      recursive: true,
    });
    await writeFile(
      join(root, 'node_modules/.pnpm/chalk@4.1.2/node_modules/chalk/package.json'),
      '{"name":"chalk","version":"4.1.2"}',
    );
    await symlink(
      join(root, 'node_modules/.pnpm/chalk@4.1.2/node_modules/chalk'),
      join(root, 'node_modules/chalk'),
    );
    const from = join(root, 'apps/support');
    expect(await findHostPackage(root, from, 'is-number')).toEqual({
      name: 'is-number',
      version: '7.0.0',
      folder: 'apps/support/node_modules/is-number',
    });
    expect(await findHostPackage(root, from, 'chalk')).toEqual({
      name: 'chalk',
      version: '4.1.2',
      folder: 'node_modules/.pnpm/chalk@4.1.2/node_modules/chalk',
    });
    expect(await findHostPackage(root, from, 'debug')).toBeUndefined();
  });
});
