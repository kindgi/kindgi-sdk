// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * workspace-source-aliases: which packages and entries get an alias, exact
 * matching, and the throws, against a scratch workspace; then against
 * @kindgi/api's own.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { workspaceSourceAliases } from './workspace-source-aliases.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A conditions entry the way the workspace writes them. */
const entry = (path) => ({
  types: path.replace(/\.js$/, '.d.ts'),
  import: path,
  default: path,
});

/**
 * A scratch workspace: one directory per package with its package.json and
 * the source files given, and `node_modules/<dep>` links as pnpm makes them.
 *
 * @param {Record<string, { manifest: Record<string, unknown>, sources?: string[] }>} packages
 */
function workspace(packages) {
  // Real, as the aliases are: macOS's tmpdir() is a link.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-source-aliases-')));
  roots.push(root);
  const dirOf = (name) => join(root, 'packages', name.split('/')[1]);
  for (const [name, { manifest, sources = [] }] of Object.entries(packages)) {
    const dir = dirOf(name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, ...manifest }));
    for (const source of sources) {
      mkdirSync(dirname(join(dir, source)), { recursive: true });
      writeFileSync(join(dir, source), 'export {};\n');
    }
  }
  for (const [name, { manifest }] of Object.entries(packages)) {
    const deps = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
    for (const dep of Object.keys(deps).filter((d) => d in packages)) {
      const link = join(dirOf(name), 'node_modules', dep);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(dirOf(dep), link, 'dir');
    }
  }
  return { root, dirOf };
}

/** @param {{ find: RegExp, replacement: string }[]} aliases */
const resolveWith = (aliases, specifier) => {
  const alias = aliases.find((a) => a.find.test(specifier));
  return alias ? specifier.replace(alias.find, alias.replacement) : undefined;
};

describe('workspace-source-aliases', () => {
  const { dirOf } = workspace({
    '@kindgi/app': {
      manifest: {
        exports: { '.': entry('./dist/index.js') },
        dependencies: { '@kindgi/lib': 'workspace:*', '@kindgi/published': '^1.0.0' },
        devDependencies: { '@kindgi/fixtures': 'workspace:*' },
      },
      sources: ['src/index.ts'],
    },
    '@kindgi/lib': {
      manifest: {
        exports: {
          '.': entry('./dist/index.js'),
          './testing': entry('./dist/testing/index.js'),
          './schema.json': './schema.json',
          './package.json': './package.json',
        },
        dependencies: { '@kindgi/base': 'workspace:*' },
        devDependencies: { '@kindgi/lib-only-dev': 'workspace:*' },
      },
      sources: ['src/index.ts', 'src/testing/index.ts'],
    },
    '@kindgi/base': {
      manifest: { exports: './dist/main.js' },
      sources: ['src/main.ts'],
    },
    '@kindgi/fixtures': {
      manifest: { exports: { '.': entry('./dist/index.js') } },
      sources: ['src/index.ts'],
    },
    '@kindgi/lib-only-dev': {
      manifest: { exports: { '.': entry('./dist/index.js') } },
      sources: ['src/index.ts'],
    },
    '@kindgi/published': {
      manifest: { exports: { '.': entry('./dist/index.js') } },
      sources: ['src/index.ts'],
    },
  });
  const aliases = workspaceSourceAliases(dirOf('@kindgi/app'));

  test('the package, its workspace deps and devDeps, and theirs transitively, load from src', () => {
    assert.equal(resolveWith(aliases, '@kindgi/app'), join(dirOf('@kindgi/app'), 'src/index.ts'));
    assert.equal(resolveWith(aliases, '@kindgi/lib'), join(dirOf('@kindgi/lib'), 'src/index.ts'));
    assert.equal(
      resolveWith(aliases, '@kindgi/fixtures'),
      join(dirOf('@kindgi/fixtures'), 'src/index.ts'),
    );
    assert.equal(resolveWith(aliases, '@kindgi/base'), join(dirOf('@kindgi/base'), 'src/main.ts'));
  });

  test("a dependency's devDependencies and a non-workspace dependency are not followed", () => {
    assert.equal(resolveWith(aliases, '@kindgi/lib-only-dev'), undefined);
    assert.equal(resolveWith(aliases, '@kindgi/published'), undefined);
  });

  test('each alias matches its own specifier only', () => {
    assert.equal(
      resolveWith(aliases, '@kindgi/lib/testing'),
      join(dirOf('@kindgi/lib'), 'src/testing/index.ts'),
    );
    assert.equal(resolveWith(aliases, '@kindgi/lib/other'), undefined);
    assert.equal(resolveWith(aliases, '@kindgi/library'), undefined);
  });

  test('an export that is not ./dist/ JavaScript has no alias', () => {
    assert.equal(resolveWith(aliases, '@kindgi/lib/schema.json'), undefined);
    assert.equal(resolveWith(aliases, '@kindgi/lib/package.json'), undefined);
  });

  test('a ./dist/ export with no source file throws, naming the package and the export', () => {
    const { dirOf: dirs } = workspace({
      '@kindgi/app': {
        manifest: {
          exports: { '.': entry('./dist/index.js') },
          dependencies: { '@kindgi/gen': 'workspace:*' },
        },
        sources: ['src/index.ts'],
      },
      '@kindgi/gen': {
        manifest: {
          exports: { '.': entry('./dist/index.js'), './generated': entry('./dist/generated.js') },
        },
        sources: ['src/index.ts'],
      },
    });
    assert.throws(
      () => workspaceSourceAliases(dirs('@kindgi/app')),
      /@kindgi\/gen\/generated exports \.\/dist\/generated\.js, which has no source at /,
    );
  });

  test('a ./dist/ subpath pattern throws', () => {
    const { dirOf: dirs } = workspace({
      '@kindgi/app': {
        manifest: { exports: { '.': entry('./dist/index.js'), './*': entry('./dist/*.js') } },
        sources: ['src/index.ts'],
      },
    });
    assert.throws(
      () => workspaceSourceAliases(dirs('@kindgi/app')),
      /@kindgi\/app\/\* is a \.\/dist\/ subpath pattern/,
    );
  });

  test('a workspace dependency that is not linked throws', () => {
    const { dirOf: dirs } = workspace({
      '@kindgi/app': {
        manifest: {
          exports: { '.': entry('./dist/index.js') },
          dependencies: { '@kindgi/gone': 'workspace:*' },
        },
        sources: ['src/index.ts'],
      },
    });
    assert.throws(
      () => workspaceSourceAliases(dirs('@kindgi/app')),
      /@kindgi\/app depends on @kindgi\/gone, which isn't linked at .*: run pnpm install/,
    );
  });

  test("@kindgi/api's closure resolves, every alias to a source file", () => {
    const apiAliases = workspaceSourceAliases(join(REPO, 'packages/api'));
    assert.equal(
      resolveWith(apiAliases, '@kindgi/types'),
      join(REPO, 'packages/types/src/index.ts'),
    );
    assert.equal(resolveWith(apiAliases, '@kindgi/api/openapi.json'), undefined);
    for (const { replacement } of apiAliases) assert.ok(existsSync(replacement), replacement);
  });
});
