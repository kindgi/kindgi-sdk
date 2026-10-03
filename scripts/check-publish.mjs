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
 *   - are-the-types-wrong on the packed tarball (ESM-only profile unless
 *     the package ships a `require` condition).
 *
 * Also: the Python SDK (`sdks/python`) shares the npm packages' major.minor.
 *
 * publint and attw run for several packages at once (`KINDGI_PUBLISH_CHECK_JOBS`,
 * default 6): one at a time they took two minutes for 38 packages.
 *
 * Requires a prior `pnpm run build`. Usage: `pnpm run check:publish`.
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

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

/** Run a root dev tool (`node_modules/.bin`, no `pnpm exec` start-up per call); its output when it fails. */
async function check(args) {
  try {
    await run(join(root, 'node_modules', '.bin', args[0]), args.slice(1), {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return undefined;
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

const tools = []; // [name, label, args] for publint and attw, run in parallel below
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

  tools.push([name, 'publint', ['publint', pkg.path, '--strict']]);
  const profile = hasRequireCondition(manifest.exports) ? [] : ['--profile', 'esm-only'];
  tools.push([name, 'are-the-types-wrong', ['attw', '--pack', pkg.path, ...profile]]);
}

// A small pool: JOBS checks at a time, results kept in package order.
const results = new Array(tools.length);
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(JOBS, tools.length) }, async () => {
    while (next < tools.length) {
      const i = next++;
      results[i] = await check(tools[i][2]);
    }
  }),
);
tools.forEach(([name, label], i) => {
  if (results[i] !== undefined) problems.push(`${name}: ${label}\n${results[i]}`);
});

// The Python SDK (`kindgi`, PyPI) shares the npm packages' major.minor: a
// published CLI writes `kindgi` within its own minor for Python packs
// (`kindgiRequirement`), so the two must move together. Patches may differ.
const npmVersion = JSON.parse(
  readFileSync(join(root, 'packages/sdk/package.json'), 'utf8'),
).version;
const pyproject = readFileSync(join(root, 'sdks/python/pyproject.toml'), 'utf8');
const pythonVersion = /^version = "([^"]+)"$/m.exec(pyproject)?.[1];
const minorOf = (v) =>
  /^(\d+)\.(\d+)\./
    .exec(v ?? '')
    ?.slice(1, 3)
    .join('.');
if (minorOf(pythonVersion) === undefined || minorOf(pythonVersion) !== minorOf(npmVersion)) {
  problems.push(
    `kindgi (sdks/python) ${pythonVersion ?? '(no version)'} must share the npm packages' major.minor (${npmVersion}): a published CLI writes kindgi within its own minor`,
  );
}

if (problems.length > 0) {
  console.error('\nPublish-readiness FAILED:\n');
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}
console.log(
  `Publish-readiness OK — ${checked} publishable package(s) checked; kindgi ${pythonVersion} shares their minor.`,
);
