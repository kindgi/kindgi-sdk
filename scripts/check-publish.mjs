#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Publish-readiness gate for every workspace package that is publishable
 * (`"private"` is not `true`). A package becomes subject to these checks
 * the moment it is made publishable — before its first release, not after.
 *
 * Per package:
 *   - README.md and LICENSE present; `license` is Apache-2.0.
 *   - `repository` points at this repository with the package `directory`
 *     (npm provenance verifies `repository.url` against the publishing
 *     repository — a mismatch fails the publish).
 *   - `publishConfig.access` is `public` and `publishConfig.provenance` is true.
 *   - publint (package.json / exports / files correctness).
 *   - are-the-types-wrong on the packed tarball: from ES modules and from
 *     CommonJS (strict, for a package that ships a `require` condition).
 *   - Every export an app loads has a `default` condition beside `import`,
 *     and loads with `require()` (`scripts/check-cjs-require.cjs`): CommonJS
 *     apps require() the ES modules, from Node 22.12. An export path ending
 *     in `-main` is a program, run with `node`: it stays import-only.
 *
 * The Python SDK's version (the npm packages', exactly) is
 * `scripts/sync-python-version.mjs --check`'s, not this script's.
 *
 * publint and attw run for several packages at once (`KINDGI_PUBLISH_CHECK_JOBS`,
 * default 6): one at a time they took two minutes for 38 packages. Each attw
 * run reads a tarball packed into a directory of its own (`pack-tarball.mjs`),
 * never `attw --pack`'s shared one in the package's folder (T395).
 *
 * Requires a prior `pnpm run build`. Usage: `pnpm run check:publish`.
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

import { withOwnTarball } from './pack-tarball.mjs';

const run = promisify(execFile);
const JOBS = Math.max(
  1,
  Number.parseInt(process.env.KINDGI_PUBLISH_CHECK_JOBS ?? '', 10) || Math.min(6, cpus().length),
);

const REPO_URL = 'git+https://github.com/kindgi/kindgi-sdk.git';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const workspace = JSON.parse(
  execFileSync('pnpm', ['ls', '-r', '--depth', '-1', '--json'], { cwd: root, encoding: 'utf8' }),
);

const problems = [];
let checked = 0;

function hasRequireCondition(exportsField) {
  return JSON.stringify(exportsField ?? {}).includes('"require"');
}

/** An export path that names a program (`node <file>`), never loaded: it stays import-only. */
const isProgram = (subpath) => subpath.endsWith('-main');

/** The `exports` entries with conditions: `[subpath, conditions]`. */
function exportEntries(exportsField) {
  return Object.entries(exportsField ?? {}).filter(
    ([, target]) => typeof target === 'object' && target !== null,
  );
}

/**
 * Run a root dev tool (`node_modules/.bin`, no `pnpm exec` start-up per call); its output when it
 * fails. With `packageDir`, the package is packed into a directory of its own first, and the
 * tarball's path is the tool's first argument.
 */
async function check(args, packageDir) {
  const tool = (argv) =>
    run(join(root, 'node_modules', '.bin', argv[0]), argv.slice(1), {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  try {
    if (packageDir === undefined) await tool(args);
    else await withOwnTarball(packageDir, (tarball) => tool([args[0], tarball, ...args.slice(1)]));
    return undefined;
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}` || String(err);
  }
}

// [name, label, args, packageDir?] for publint and attw, run in parallel below; attw gets
// `packageDir`, packed into a directory of its own (`check`).
const tools = [];
const cjsChecked = []; // package dirs for the CommonJS check
for (const pkg of workspace) {
  if (pkg.path === root) continue;
  const manifest = JSON.parse(readFileSync(join(pkg.path, 'package.json'), 'utf8'));
  if (manifest.private === true) continue;
  checked += 1;
  const name = manifest.name;
  const dir = relative(root, pkg.path);

  if (!existsSync(join(pkg.path, 'README.md'))) problems.push(`${name}: README.md missing`);
  if (!existsSync(join(pkg.path, 'LICENSE'))) problems.push(`${name}: LICENSE missing`);
  if (manifest.license !== 'Apache-2.0') problems.push(`${name}: license is not Apache-2.0`);
  const repo = manifest.repository;
  if (repo?.url !== REPO_URL || repo?.directory !== dir) {
    problems.push(`${name}: repository must be { url: "${REPO_URL}", directory: "${dir}" }`);
  }
  if (manifest.publishConfig?.access !== 'public' || manifest.publishConfig?.provenance !== true) {
    problems.push(`${name}: publishConfig must set access "public" and provenance true`);
  }

  // CommonJS apps `require()` the packages (Node's require(esm), from Node
  // 22.12): every entry an app loads answers `default` (or `require`).
  const entries = exportEntries(manifest.exports);
  for (const [subpath, conditions] of entries) {
    if (isProgram(subpath) || conditions.import === undefined) continue;
    if (conditions.default === undefined && conditions.require === undefined) {
      problems.push(
        `${name}: export "${subpath}" has an "import" condition but no "default": a CommonJS app can't require() it`,
      );
    }
  }
  cjsChecked.push(pkg.path);

  tools.push([name, 'publint', ['publint', pkg.path, '--strict']]);
  if (hasRequireCondition(manifest.exports)) {
    tools.push([name, 'are-the-types-wrong', ['attw'], pkg.path]);
  } else {
    // ES modules for every caller. From CommonJS they resolve and are typed
    // through `default`; loading them with `require()` is Node 22.12's and
    // TypeScript 5.8's (`module: nodenext`), which attw doesn't model yet, so
    // its "ESM (dynamic import only)" is expected. Programs are import-only,
    // so they're checked as ES modules alone.
    const programs = entries.map(([subpath]) => subpath).filter(isProgram);
    tools.push([
      name,
      'are-the-types-wrong',
      [
        'attw',
        '--profile',
        'node16',
        '--ignore-rules',
        'cjs-resolves-to-esm',
        ...(programs.length > 0 ? ['--exclude-entrypoints', ...programs] : []),
      ],
      pkg.path,
    ]);
    if (programs.length > 0) {
      tools.push([
        name,
        'are-the-types-wrong (programs)',
        ['attw', '--profile', 'esm-only', '--entrypoints', ...programs],
        pkg.path,
      ]);
    }
  }
}

// A real CommonJS caller: every entry loads with `require()` where it loads
// with `import()` (`scripts/check-cjs-require.cjs`).
let cjsSummary = '';
try {
  cjsSummary = execFileSync(
    process.execPath,
    [join(root, 'scripts', 'check-cjs-require.cjs'), ...cjsChecked],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
} catch (err) {
  problems.push(`CommonJS require() check\n${err.stdout ?? ''}${err.stderr ?? ''}`);
}

// A small pool: JOBS checks at a time, results kept in package order.
const results = new Array(tools.length);
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(JOBS, tools.length) }, async () => {
    while (next < tools.length) {
      const i = next++;
      results[i] = await check(tools[i][2], tools[i][3]);
    }
  }),
);
tools.forEach(([name, label], i) => {
  if (results[i] !== undefined) problems.push(`${name}: ${label}\n${results[i]}`);
});

if (problems.length > 0) {
  console.error('\nPublish-readiness FAILED:\n');
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}
console.log(
  `Publish-readiness OK — ${checked} publishable package(s) checked. ${cjsSummary.trim()}`,
);
