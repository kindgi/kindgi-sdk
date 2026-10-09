#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * License-header gate: every tracked source file declares an
 * `SPDX-License-Identifier` in its first lines, and the identifier is
 * compatible with the `license` of the package the file belongs to
 * (nearest package.json; the root package.json for files outside any
 * package):
 *
 *   - Apache-2.0 package → the file must be Apache-2.0. Public code stays
 *     permissive end to end.
 *   - Any other license → the package's own license, or Apache-2.0
 *     (inbound-compatible, so Apache-2.0 code can be reused in such a
 *     package with its original header).
 *
 * Every such file also carries the copyright line
 *   `Copyright (C) <year> Kindgi Inc.`
 * (a year range like `2026-2027` is fine) — the only copyright holder in
 * this repository.
 *
 * Python sources (`sdks/python`) and Java sources (`sdks/java`) count: they
 * take the root package's license, as files outside any package.json do.
 *
 * Skips `*.d.ts` / `*.d.cts` / `*.d.mts` (generated declarations) and
 * `website/` (a separate project with its own toolchain, when present).
 *
 * Usage: `pnpm run check:headers` (CI runs it).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs|py|java)$/;
const DECLARATION = /\.d\.(ts|mts|cts)$/;
const SKIP_DIRS = ['website/'];
const PERMISSIVE = 'Apache-2.0';
const HEADER_LINES = 5;
const COPYRIGHT = /Copyright \(C\) \d{4}(?:-\d{4})? Kindgi Inc\./;

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const rootLicense = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).license;
const licenseByDir = new Map();

function packageLicense(file) {
  let dir = dirname(file);
  const visited = [];
  for (;;) {
    if (licenseByDir.has(dir)) break;
    visited.push(dir);
    const manifest = join(root, dir, 'package.json');
    if (dir !== '.' && existsSync(manifest)) {
      licenseByDir.set(dir, JSON.parse(readFileSync(manifest, 'utf8')).license || rootLicense);
      break;
    }
    if (dir === '.') {
      licenseByDir.set(dir, rootLicense);
      break;
    }
    dir = dirname(dir);
  }
  const license = licenseByDir.get(dir);
  for (const d of visited) licenseByDir.set(d, license);
  return license;
}

const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter((f) => SOURCE.test(f) && !DECLARATION.test(f) && !SKIP_DIRS.some((d) => f.startsWith(d)));

const problems = [];
for (const file of files) {
  const head = readFileSync(join(root, file), 'utf8').split('\n').slice(0, HEADER_LINES).join('\n');
  const declared = head.match(/SPDX-License-Identifier:\s*(\S+)/)?.[1];
  const expected = packageLicense(file);
  if (declared === undefined) {
    problems.push(`${file}: no SPDX-License-Identifier header (package license: ${expected})`);
  } else if (
    expected === PERMISSIVE
      ? declared !== PERMISSIVE
      : declared !== expected && declared !== PERMISSIVE
  ) {
    problems.push(`${file}: declares ${declared}, package license is ${expected}`);
  }
  if (!COPYRIGHT.test(head)) {
    problems.push(`${file}: missing \`Copyright (C) <year> Kindgi Inc.\` in its header`);
  }
}

if (problems.length > 0) {
  console.error(`\nLicense-header check FAILED — ${problems.length} file(s):\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nSee CONTRIBUTING.md for the header each package uses.\n');
  process.exit(1);
}
console.log(`License-header check OK — ${files.length} source files.`);
