#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Keeps this repository self-contained: every package builds from what is
 * in this repository plus third-party packages from the public registry.
 *
 * For every workspace package (discovered via `pnpm ls -r`):
 *   1. A `workspace:` dependency must name a package in this repository.
 *   2. No `link:` / `file:` / `portal:` dependencies — they can reach
 *      outside the repository.
 *   3. Every `@kindgi/*` dependency must be a package in this repository
 *      (the scope is owned here; nothing in it comes from elsewhere).
 *   4. A package declares the toolchain it uses — `typescript` and
 *      `@types/node` when a script runs `tsc` (the shared tsconfig targets
 *      Node with `lib: ES2023` and no DOM, so Node's ambient types —
 *      `AbortSignal`, `console`, `setTimeout`, `URL`, … — come from
 *      `@types/node`), `@types/node` also when a source uses Node APIs,
 *      and `vitest` when a script runs it or a source imports it — instead
 *      of borrowing the root's. Packages must also build inside another
 *      pnpm workspace that consumes this repository, where nothing is
 *      hoisted from this repository's root.
 *
 * Runtime capabilities are expressed as binding interfaces the host
 * supplies — never as a dependency on a runtime implementation.
 *
 * Usage: `pnpm run check:border` (CI runs it).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const OWN_SCOPE = '@kindgi/';
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const NODE_API =
  /from ['"]node:|require\(['"]node:|\bprocess\.|\bBuffer\b|__dirname|import\.meta\.url|\bnew URL\(/;
const VITEST_IMPORT = /from ['"]vitest['"]/;

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const workspace = JSON.parse(
  execFileSync('pnpm', ['ls', '-r', '--depth', '-1', '--json'], { cwd: root, encoding: 'utf8' }),
);
const inRepo = new Set(workspace.map((p) => p.name));

const violations = [];
for (const pkg of workspace) {
  const manifest = JSON.parse(readFileSync(join(pkg.path, 'package.json'), 'utf8'));
  for (const field of DEP_FIELDS) {
    for (const [dep, spec] of Object.entries(manifest[field] ?? {})) {
      const where = `${pkg.name}: ${field} → ${dep}@${spec}`;
      if (spec.startsWith('workspace:') && !inRepo.has(dep)) {
        violations.push(`${where} (workspace: dependency not in this repository)`);
      }
      if (/^(link|file|portal):/.test(spec)) {
        violations.push(`${where} (may resolve outside this repository)`);
      }
      if (dep.startsWith(OWN_SCOPE) && !inRepo.has(dep)) {
        violations.push(`${where} (${OWN_SCOPE}* packages must live in this repository)`);
      }
    }
  }
  if (pkg.path === root) continue;
  for (const tool of undeclaredToolchain(pkg.path, manifest)) {
    violations.push(
      `${pkg.name}: uses ${tool} but does not declare it (add it to devDependencies)`,
    );
  }
}

/** Toolchain packages this package uses without declaring them. */
function undeclaredToolchain(dir, manifest) {
  const declared = new Set(DEP_FIELDS.flatMap((field) => Object.keys(manifest[field] ?? {})));
  const scripts = Object.values(manifest.scripts ?? {}).join('\n');
  const sources = execFileSync('git', ['ls-files', '-z', '--', '.'], { cwd: dir, encoding: 'utf8' })
    .split('\0')
    .filter((file) => SOURCE.test(file) && !file.endsWith('.d.ts'))
    .map((file) => readFileSync(join(dir, file), 'utf8'));
  const uses = {
    typescript: /\btsc\b/.test(scripts),
    vitest: /\bvitest\b/.test(scripts) || sources.some((text) => VITEST_IMPORT.test(text)),
    '@types/node': /\btsc\b/.test(scripts) || sources.some((text) => NODE_API.test(text)),
  };
  return Object.entries(uses)
    .filter(([tool, used]) => used && !declared.has(tool))
    .map(([tool]) => tool);
}

if (violations.length > 0) {
  console.error(`\nSelf-containment check FAILED — ${violations.length} violation(s):\n`);
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    '\nExpress runtime needs as binding interfaces the host supplies, never as a\n' +
      'dependency on something outside this repository.\n',
  );
  process.exit(1);
}
console.log(`Self-containment check OK — ${workspace.length} workspace packages.`);
