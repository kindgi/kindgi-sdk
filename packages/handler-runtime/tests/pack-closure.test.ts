// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The package closure of a pack's bundles, on install trees laid out as
 * pnpm (isolated, links into `.pnpm`) and npm (hoisted, nested copies)
 * lay them out; then the trimmed tree, which Node itself loads.
 */

import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { checkLoads, main } from '../src/kindgi-closure.js';
import {
  closureReport,
  computeClosure,
  formatClosureReport,
  writeClosure,
} from '../src/pack-closure.js';

const run = promisify(execFile);

let tmp: string;

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'kindgi-closure-')));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

interface PackageSpec {
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  /** The package's index.js body (ESM). Default: export its name, after importing its dependencies. */
  readonly body?: string;
}

/** A package folder: its manifest, an ESM index that imports its dependencies, and a data file. */
async function pkg(dir: string, name: string, spec: PackageSpec = {}): Promise<void> {
  await mkdir(dir, { recursive: true });
  const { body, ...deps } = spec;
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'index.js', ...deps }),
  );
  const imports = Object.keys(spec.dependencies ?? {})
    .map((d, i) => `import d${i} from '${d}';`)
    .join('\n');
  await writeFile(
    join(dir, 'index.js'),
    body ?? `${imports}\nexport default ${JSON.stringify(name)};\n`,
  );
  await writeFile(join(dir, 'data.txt'), `${name}'s own file\n`);
}

/** A relative link, as pnpm writes them. */
async function link(path: string, target: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await symlink(relative(dirname(path), target), path);
}

/**
 * pnpm, isolated: the pack at `/app/pack` imports `pg` and `@acme/util`
 * and doesn't import `next`, a dependency of its too. `pg` depends on
 * `pg-types` and optionally on `pg-native`, which isn't installed.
 */
async function pnpmTree(): Promise<{ root: string; pack: string }> {
  const root = join(tmp, 'app');
  const store = join(root, 'node_modules', '.pnpm');
  const pack = join(root, 'pack');
  await writeFile(
    join(await mkdirp(root), 'package.json'),
    JSON.stringify({ name: 'acme-root', private: true }),
  );
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  await pkg(pack, 'acme-pack', {
    dependencies: { pg: '^8', '@acme/util': '^1', next: '^1' },
  });
  await pkg(join(store, 'pg@8.0.0/node_modules/pg'), 'pg', {
    dependencies: { 'pg-types': '^2' },
    optionalDependencies: { 'pg-native': '^3' },
  });
  await link(
    join(store, 'pg@8.0.0/node_modules/pg-types'),
    join(store, 'pg-types@2.0.0/node_modules/pg-types'),
  );
  await pkg(join(store, 'pg-types@2.0.0/node_modules/pg-types'), 'pg-types');
  await pkg(join(store, '@acme+util@1.0.0/node_modules/@acme/util'), '@acme/util');
  await pkg(join(store, 'next@1.0.0/node_modules/next'), 'next', {
    dependencies: { react: '^19' },
  });
  await link(
    join(store, 'next@1.0.0/node_modules/react'),
    join(store, 'react@19.0.0/node_modules/react'),
  );
  await pkg(join(store, 'react@19.0.0/node_modules/react'), 'react');
  await link(join(pack, 'node_modules/pg'), join(store, 'pg@8.0.0/node_modules/pg'));
  await link(
    join(pack, 'node_modules/@acme/util'),
    join(store, '@acme+util@1.0.0/node_modules/@acme/util'),
  );
  await link(join(pack, 'node_modules/next'), join(store, 'next@1.0.0/node_modules/next'));
  await mkdir(join(pack, 'dist'), { recursive: true });
  return { root, pack };
}

async function mkdirp(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('computeClosure', () => {
  test('pnpm: the externals and their installed dependencies, by real folder, with the links on the way', async () => {
    const { root, pack } = await pnpmTree();
    const closure = await computeClosure({
      root,
      bundleDir: join(pack, 'dist'),
      externals: ['pg', '@acme/util'],
      keep: [],
    });
    expect(closure.missing).toEqual([]);
    expect(closure.packages.map((p) => [p.name, relative(root, p.dir), p.reason])).toEqual([
      ['@acme/util', 'node_modules/.pnpm/@acme+util@1.0.0/node_modules/@acme/util', 'external'],
      ['pg-types', 'node_modules/.pnpm/pg-types@2.0.0/node_modules/pg-types', 'a dependency of pg'],
      ['pg', 'node_modules/.pnpm/pg@8.0.0/node_modules/pg', 'external'],
    ]);
    expect(closure.links.map((l) => relative(root, l.path))).toEqual([
      'node_modules/.pnpm/pg@8.0.0/node_modules/pg-types',
      'pack/node_modules/@acme/util',
      'pack/node_modules/pg',
    ]);
  });

  test('npm, hoisted: a nested copy wins where Node would take it, and what nothing loads is dropped', async () => {
    const root = join(tmp, 'app');
    await writeFile(
      join(await mkdirp(root), 'package.json'),
      JSON.stringify({ name: 'acme', dependencies: { a: '1' } }),
    );
    await pkg(join(root, 'node_modules/a'), 'a', { dependencies: { b: '^2' } });
    await pkg(join(root, 'node_modules/a/node_modules/b'), 'b');
    await pkg(join(root, 'node_modules/b'), 'b');
    await pkg(join(root, 'node_modules/c'), 'c');
    const closure = await computeClosure({
      root,
      bundleDir: join(root, 'dist'),
      externals: ['a'],
      keep: [],
    });
    expect(closure.packages.map((p) => relative(root, p.dir))).toEqual([
      'node_modules/a',
      'node_modules/a/node_modules/b',
    ]);
    expect(closure.links).toEqual([]);
  });

  test("peers that are installed are kept, from the package's own folder", async () => {
    const { root, pack } = await pnpmTree();
    const store = join(root, 'node_modules', '.pnpm');
    await pkg(join(store, 'knex@3.0.0/node_modules/knex'), 'knex', {
      peerDependencies: { pg: '^8', mysql2: '^3' },
      body: 'export default "knex";\n',
    });
    await link(join(store, 'knex@3.0.0/node_modules/pg'), join(store, 'pg@8.0.0/node_modules/pg'));
    await link(join(pack, 'node_modules/knex'), join(store, 'knex@3.0.0/node_modules/knex'));
    const closure = await computeClosure({
      root,
      bundleDir: join(pack, 'dist'),
      externals: ['knex'],
      keep: [],
    });
    expect(closure.packages.map((p) => p.name)).toEqual(['knex', 'pg-types', 'pg']);
  });

  test("a keep resolves beside a kept package: Prisma's generated .prisma/client next to @prisma/client", async () => {
    const { root, pack } = await pnpmTree();
    const at = join(root, 'node_modules/.pnpm/@prisma+client@6.19.3/node_modules');
    await pkg(join(at, '@prisma/client'), '@prisma/client');
    await pkg(join(at, '.prisma/client'), '.prisma/client');
    await link(join(pack, 'node_modules/@prisma/client'), join(at, '@prisma/client'));
    const closure = await computeClosure({
      root,
      bundleDir: join(pack, 'dist'),
      externals: ['@prisma/client'],
      keep: ['.prisma/client'],
    });
    expect(closure.packages.map((p) => [p.name, p.reason])).toEqual([
      ['.prisma/client', 'keep'],
      ['@prisma/client', 'external'],
    ]);
  });

  test("an extension's keep that isn't installed is skipped: Prisma 7 has no .prisma/client", async () => {
    const { root, pack } = await pnpmTree();
    const closure = await computeClosure({
      root,
      bundleDir: join(pack, 'dist'),
      externals: ['pg'],
      keep: [],
      keepIfInstalled: ['.prisma/client'],
    });
    expect(closure.missing).toEqual([]);
    expect(closure.skipped).toEqual(['.prisma/client']);
    expect(closure.packages.map((p) => p.name)).toEqual(['pg-types', 'pg']);
  });

  test('an external or a keep that is not installed is missing, by name', async () => {
    const { root, pack } = await pnpmTree();
    const closure = await computeClosure({
      root,
      bundleDir: join(pack, 'dist'),
      externals: ['pg', 'sharp'],
      keep: ['pino-pretty'],
    });
    expect(closure.missing).toEqual([
      { name: 'sharp', reason: 'external' },
      { name: 'pino-pretty', reason: 'keep' },
    ]);
  });

  test('nothing outside the install root is kept', async () => {
    const { root, pack } = await pnpmTree();
    await pkg(join(tmp, 'node_modules/outside'), 'outside');
    const closure = await computeClosure({
      root,
      bundleDir: join(pack, 'dist'),
      externals: ['outside'],
      keep: [],
    });
    expect(closure.missing).toEqual([{ name: 'outside', reason: 'external' }]);
  });
});

describe('writeClosure', () => {
  test('the trimmed tree: everything but node_modules, the kept packages and their links; Node loads it', async () => {
    const { root, pack } = await pnpmTree();
    const closure = await computeClosure({
      root,
      bundleDir: join(pack, 'dist'),
      externals: ['pg', '@acme/util'],
      keep: [],
    });
    const out = join(tmp, 'out');
    await writeClosure(closure, root, out);

    // What isn't a dependency stays as it was.
    expect(await readFile(join(out, 'pnpm-lock.yaml'), 'utf8')).toBe('lockfileVersion: 9.0\n');
    expect(await readFile(join(out, 'pack/package.json'), 'utf8')).toContain('acme-pack');
    // A kept package whole; a link as pnpm wrote it.
    expect(
      await readFile(join(out, 'node_modules/.pnpm/pg@8.0.0/node_modules/pg/data.txt'), 'utf8'),
    ).toBe("pg's own file\n");
    expect((await lstat(join(out, 'pack/node_modules/pg'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(out, 'pack/node_modules/pg'))).toBe(
      await readlink(join(root, 'pack/node_modules/pg')),
    );
    // Dropped: next, and react with it.
    await expect(lstat(join(out, 'node_modules/.pnpm/next@1.0.0'))).rejects.toThrow();
    await expect(lstat(join(out, 'pack/node_modules/next'))).rejects.toThrow();

    // Node, from the bundles' folder in the trimmed tree.
    await mkdir(join(out, 'pack/dist'), { recursive: true });
    await writeFile(
      join(out, 'pack/dist/main.mjs'),
      "import pg from 'pg'; import util from '@acme/util';\nconsole.log(pg, util);\n",
    );
    const { stdout } = await run(process.execPath, [join(out, 'pack/dist/main.mjs')]);
    expect(stdout.trim()).toBe('pg @acme/util');
    await writeFile(join(out, 'pack/dist/next.mjs'), "await import('next');\n");
    await expect(run(process.execPath, [join(out, 'pack/dist/next.mjs')])).rejects.toThrow(/next/);
  });

  test('npm, hoisted: a kept package without the nested copies nothing loads', async () => {
    const root = join(tmp, 'app');
    await writeFile(join(await mkdirp(root), 'package.json'), JSON.stringify({ name: 'acme' }));
    await pkg(join(root, 'node_modules/a'), 'a', { dependencies: { b: '^2' } });
    await pkg(join(root, 'node_modules/a/node_modules/b'), 'b');
    await pkg(join(root, 'node_modules/a/node_modules/unused'), 'unused');
    const closure = await computeClosure({
      root,
      bundleDir: join(root, 'dist'),
      externals: ['a'],
      keep: [],
    });
    const out = join(tmp, 'out');
    await writeClosure(closure, root, out);
    expect(await readFile(join(out, 'node_modules/a/node_modules/b/data.txt'), 'utf8')).toBe(
      "b's own file\n",
    );
    await expect(lstat(join(out, 'node_modules/a/node_modules/unused'))).rejects.toThrow();
  });
});

describe('closureReport', () => {
  test("counts what's kept of what's installed, and names the pack's own dependencies it dropped", async () => {
    const { root, pack } = await pnpmTree();
    const closure = await computeClosure({
      root,
      bundleDir: join(pack, 'dist'),
      externals: ['pg', '@acme/util'],
      keep: [],
    });
    const report = await closureReport(closure, root, pack);
    expect(report).toMatchObject({ kept: 3, installed: 5, droppedOwn: ['next'] });
    expect(report.keptBytes).toBeGreaterThan(0);
    expect(report.keptBytes).toBeLessThan(report.installedBytes);
    expect(
      formatClosureReport({ ...report, keptBytes: 61_200_000, installedBytes: 2_310_000_000 }),
    ).toEqual([
      'kept 3 of 5 packages (61.2 MB of 2.31 GB)',
      "dropped 1 of the pack's own dependencies its tools don't import: next",
    ]);
  });
});

describe('the kindgi-closure process', () => {
  async function externalsFile(packages: string[], specifiers = packages): Promise<string> {
    const path = join(tmp, 'externals.json');
    await writeFile(path, JSON.stringify({ packages, specifiers }));
    return path;
  }

  test('trim writes the tree and prints its report', async () => {
    const { root, pack } = await pnpmTree();
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      [
        'trim',
        '--root',
        root,
        '--bundle-dir',
        join(pack, 'dist'),
        '--externals',
        await externalsFile(['pg']),
        '--out',
        join(tmp, 'out'),
      ],
      { out: (l) => out.push(l), err: (l) => err.push(l) },
    );
    expect({ code, err }).toEqual({ code: 0, err: [] });
    expect(out[0]).toMatch(/^kept 2 of 5 packages \(/);
    expect(out[1]).toBe(
      "dropped 2 of the pack's own dependencies its tools don't import: @acme/util, next",
    );
  });

  test('trim fails on a miss, naming it and what to do', async () => {
    const { root, pack } = await pnpmTree();
    const err: string[] = [];
    const code = await main(
      [
        'trim',
        '--root',
        root,
        '--bundle-dir',
        join(pack, 'dist'),
        '--externals',
        await externalsFile(['sharp']),
        '--keep',
        'pino-pretty',
        '--out',
        join(tmp, 'out'),
      ],
      { out: () => undefined, err: (l) => err.push(l) },
    );
    expect(code).toBe(1);
    expect(err).toEqual([
      `sharp: the pack's code imports it, and it isn't installed where Node looks from ${join(pack, 'dist')}. Add it to the pack's package.json dependencies.`,
      "pino-pretty (image.keep): it isn't installed, from the bundles' folder or beside a package the image keeps. Check the name, or remove it from image.keep.",
    ]);
  });

  test('check loads every import as the bundles import it, on the trimmed tree', async () => {
    const { root, pack } = await pnpmTree();
    const closure = await computeClosure({
      root,
      bundleDir: join(pack, 'dist'),
      externals: ['pg'],
      keep: [],
    });
    const out = join(tmp, 'out');
    await writeClosure(closure, root, out);
    const bundleDir = join(out, 'pack/dist');
    await mkdir(bundleDir, { recursive: true });

    expect(await checkLoads(['pg'], bundleDir)).toEqual({ missing: [], warnings: [] });
    const outcome = await checkLoads(['pg', '@acme/util'], bundleDir);
    expect(outcome.missing.map((m) => m.specifier)).toEqual(['@acme/util']);
    expect(outcome.missing[0]?.message).toContain('@acme/util');
    // The loader it writes is gone afterwards.
    await expect(lstat(join(bundleDir, '.kindgi-load-check.mjs'))).rejects.toThrow();
  });

  test("check: a package that throws as it loads, for another reason than a missing one, isn't a miss", async () => {
    const root = join(tmp, 'app');
    await pkg(join(root, 'node_modules/needs-env'), 'needs-env', {
      body: "throw new Error('DATABASE_URL is not set');\n",
    });
    const bundleDir = await mkdirp(join(root, 'dist'));
    const outcome = await checkLoads(['needs-env'], bundleDir);
    expect(outcome.missing).toEqual([]);
    expect(outcome.warnings).toEqual([
      "needs-env loaded with an error that isn't a missing package (DATABASE_URL is not set); not a closure miss",
    ]);
  });
});
