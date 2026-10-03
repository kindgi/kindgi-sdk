#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * After a release: every publishable workspace package (`"private"` is not
 * `true`) has its `<name>@<version>` tag on `origin`. Fails with the
 * missing tags otherwise.
 *
 * `changeset git-tag` reports a tag as created even when `git tag` fails
 * (it ignores git's exit code), so the release job checks the remote
 * rather than trusting that report.
 *
 * Usage: `node scripts/check-release-tags.mjs` (in a checkout of the
 * released commit, after `git push --tags`).
 */

import { execFileSync } from 'node:child_process';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const workspace = JSON.parse(
  execFileSync('pnpm', ['ls', '-r', '--depth', '-1', '--json'], { cwd: root, encoding: 'utf8' }),
);

const expected = workspace
  .filter((pkg) => pkg.private !== true && pkg.name !== undefined && pkg.version !== undefined)
  .map((pkg) => `${pkg.name}@${pkg.version}`);

const remote = new Set(
  execFileSync('git', ['ls-remote', '--tags', '--refs', 'origin'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t')[1].replace(/^refs\/tags\//, '')),
);

if (expected.length === 0) {
  console.error('check-release-tags: no publishable packages found');
  process.exit(1);
}
const missing = expected.filter((tag) => !remote.has(tag));
if (missing.length > 0) {
  console.error(
    `check-release-tags: ${missing.length} of ${expected.length} release tags are not on origin:`,
  );
  for (const tag of missing) console.error(`  - ${tag}`);
  process.exit(1);
}
console.log(`check-release-tags: all ${expected.length} release tags are on origin`);
