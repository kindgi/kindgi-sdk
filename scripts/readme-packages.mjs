#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Keeps the package table in README.md in step with the packages: one
 * row per workspace package (name, link, first sentence of its
 * `package.json` description), between the `packages:start` /
 * `packages:end` markers.
 *
 * Usage:
 *   pnpm run readme:packages          rewrite the table
 *   pnpm run check:readme             fail if the table is out of date (CI)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const START = '<!-- packages:start -->';
const END = '<!-- packages:end -->';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const manifests = execFileSync(
  'git',
  [
    'ls-files',
    '--',
    'packages/*/package.json',
    'packages/adapters/*/package.json',
    'sdks/*/package.json',
  ],
  { cwd: root, encoding: 'utf8' },
)
  .split('\n')
  .filter((f) => f !== '');

const packages = manifests
  .map((file) => {
    const manifest = JSON.parse(readFileSync(join(root, file), 'utf8'));
    return {
      dir: dirname(file),
      name: String(manifest.name),
      description: String(manifest.description ?? ''),
    };
  })
  .filter((p) => p.name.startsWith('@kindgi/'))
  // Library packages by name, then the SDKs under sdks/.
  .sort((a, b) =>
    a.dir.startsWith('sdks/') === b.dir.startsWith('sdks/')
      ? a.name.localeCompare(b.name)
      : a.dir.startsWith('sdks/')
        ? 1
        : -1,
  );

const rows = packages.map((p) => {
  const firstSentence = p.description.split(/(?<=\.)\s/)[0].replace(/\|/g, '\\|');
  return `| [\`${p.name}\`](./${p.dir}) | ${firstSentence} |`;
});
const table = ['| Package | Description |', '|---|---|', ...rows].join('\n');

const readmePath = join(root, 'README.md');
const readme = readFileSync(readmePath, 'utf8');
const start = readme.indexOf(START);
const end = readme.indexOf(END);
if (start === -1 || end === -1 || end < start) {
  console.error(`README.md needs the ${START} / ${END} markers around the package table.`);
  process.exit(1);
}
const next = `${readme.slice(0, start + START.length)}\n${table}\n${readme.slice(end)}`;

if (process.argv.includes('--check')) {
  if (next !== readme) {
    console.error('README package table is out of date — run `pnpm run readme:packages`.');
    process.exit(1);
  }
  console.log(`README package table OK — ${packages.length} packages.`);
} else {
  writeFileSync(readmePath, next);
  console.log(`README package table written — ${packages.length} packages.`);
}
