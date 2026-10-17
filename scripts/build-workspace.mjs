#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Workspace build orchestrator.
 *
 * Why: `pnpm -r run build` uses the FULL workspace graph (dependencies
 * + devDependencies) to compute topological order, and runs a cycle's
 * packages in arbitrary order; on a fresh clone (CI) the wrong order
 * surfaces as `Cannot find module`. `pnpm run check:cycles` keeps the
 * workspace free of cycles (the last one, `@kindgi/api` ↔
 * `@kindgi/testing`, went with `@kindgi/api/testing`), and this script
 * still orders by production deps, deterministically.
 *
 * What this script does: topologically sort every workspace package by
 * PROD dependencies only (ignoring devDependencies), then invoke
 * `pnpm --filter <name> run build` for each in order. Cycles evaporate
 * because they're all devDep-driven.
 *
 * Runtime: sequential (one package at a time). Slower than parallel
 * but deterministic. For dev, `pnpm -r --workspace-concurrency=N run
 * build` still works when caches are warm — this script is for CI +
 * fresh-clone reproducibility.
 *
 * `--target <name>` (repeatable) builds only the target(s) plus their
 * transitive build-relevant workspace deps, in the same order — e.g. to
 * build one package for a container image. (`pnpm --filter '<pkg>...' run build` is NOT a
 * substitute: it orders by devDependencies too, so dev-only cycles make
 * its order arbitrary.)
 *
 * Packages are discovered via `pnpm ls -r`, so any workspace layout
 * (including globs that reach a sibling checkout) is picked up without a
 * hand-maintained list.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every workspace package directory (excluding the root), per pnpm. */
function workspacePackageDirs() {
  const listed = JSON.parse(
    execFileSync('pnpm', ['ls', '-r', '--depth', '-1', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }),
  );
  return listed.map((p) => p.path).filter((p) => resolve(p) !== REPO_ROOT);
}

/**
 * Discover every workspace package. Returns [{ name, path, deps: Set<string> }].
 * `deps` includes only in-workspace `dependencies` (not devDependencies).
 */
function discoverPackages() {
  const packagesByPath = new Map();
  for (const pkgDir of workspacePackageDirs()) {
    const pkgJsonPath = join(pkgDir, 'package.json');
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    } catch {
      continue;
    }
    if (typeof pkg.name !== 'string') continue;
    if (pkg.private === false && pkg.scripts?.build === undefined) continue;
    packagesByPath.set(pkgDir, {
      name: pkg.name,
      path: pkgDir,
      hasBuild: pkg.scripts?.build !== undefined,
      prodDeps: pkg.dependencies ?? {},
      allDeclaredDeps: {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
        ...(pkg.peerDependencies ?? {}),
      },
    });
  }

  const workspaceNames = new Set([...packagesByPath.values()].map((p) => p.name));

  // Collect every workspace dep referenced from build-relevant source dirs
  // (src/, and package roots for sdks). Deps referenced only from tests/
  // don't participate in build order.
  for (const pkg of packagesByPath.values()) {
    const candidates = new Set(
      Object.keys(pkg.allDeclaredDeps).filter((name) => workspaceNames.has(name)),
    );
    const buildRelevant = new Set(
      Object.keys(pkg.prodDeps).filter((name) => workspaceNames.has(name)),
    );
    // Grep source dirs for imports of any candidate — devDep imported
    // from src/ IS a build dep (e.g., dts-bundle-generator sources).
    const scanDirs = ['src', '.'].filter((d) => {
      const abs = join(pkg.path, d);
      if (!existsSync(abs)) return false;
      // For '.' we only want top-level source files, not subdirs
      return d === 'src' ? statSync(abs).isDirectory() : false;
    });
    for (const dep of candidates) {
      if (buildRelevant.has(dep)) continue;
      if (isImportedFromBuildSource(pkg.path, dep, scanDirs)) {
        buildRelevant.add(dep);
      }
    }
    pkg.deps = buildRelevant;
  }
  return [...packagesByPath.values()];
}

/**
 * Cheap grep: does `pkg` reference `dep` in any src/*.ts (or its own
 * top-level source when there's no src/)? Recurses through src/ only.
 */
function isImportedFromBuildSource(pkgPath, dep, extraDirs = []) {
  const needleFrom = `from '${dep}'`;
  const needleFromDbl = `from "${dep}"`;
  const needleImport = `import('${dep}')`;
  const needleImportDbl = `import("${dep}")`;
  const stack = [join(pkgPath, 'src'), ...extraDirs.map((d) => join(pkgPath, d))];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip node_modules, dist, tests dirs — build-relevant source only
        if (['node_modules', 'dist', 'tests', '__tests__'].includes(entry.name)) continue;
        stack.push(full);
        continue;
      }
      if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) continue;
      if (/\.test\.[a-z]+$/.test(entry.name)) continue;
      let text;
      try {
        text = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      if (
        text.includes(needleFrom) ||
        text.includes(needleFromDbl) ||
        text.includes(needleImport) ||
        text.includes(needleImportDbl)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Kahn's topological sort over prod deps. Returns a flat array of
 * package names in build order. Throws if a genuine prod-dep cycle
 * exists (which would be a real bug the maintainer should fix).
 */
function topoSort(packages) {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const inDegree = new Map();
  const reverseAdj = new Map(); // name -> Set of packages that depend on it
  for (const pkg of packages) {
    inDegree.set(pkg.name, 0);
    reverseAdj.set(pkg.name, new Set());
  }
  for (const pkg of packages) {
    for (const dep of pkg.deps) {
      if (!byName.has(dep)) continue;
      inDegree.set(pkg.name, inDegree.get(pkg.name) + 1);
      reverseAdj.get(dep).add(pkg.name);
    }
  }
  const queue = [...packages].filter((p) => inDegree.get(p.name) === 0);
  const order = [];
  while (queue.length > 0) {
    // Stable order — sort by name so build output is deterministic.
    queue.sort((a, b) => a.name.localeCompare(b.name));
    const pkg = queue.shift();
    order.push(pkg);
    for (const dependent of reverseAdj.get(pkg.name)) {
      const newDeg = inDegree.get(dependent) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) queue.push(byName.get(dependent));
    }
  }
  if (order.length !== packages.length) {
    const stuck = packages
      .filter((p) => inDegree.get(p.name) > 0)
      .map((p) => `  - ${p.name} (indegree ${inDegree.get(p.name)})`)
      .join('\n');
    throw new Error(
      `Prod-dep cycle detected among workspace packages. Not fixable by this script — a real workspace dep needs relocating:\n${stuck}`,
    );
  }
  return order;
}

function buildOne(pkg) {
  if (!pkg.hasBuild) return { skipped: true };
  const result = spawnSync('pnpm', ['--filter', pkg.name, 'run', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  return { skipped: false, code: result.status ?? 1 };
}

/** `--target <name>` values from argv (repeatable). */
function parseTargets(argv) {
  const targets = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--target') {
      const name = argv[i + 1];
      if (name === undefined || name.startsWith('--')) {
        throw new Error('--target requires a package name');
      }
      targets.push(name);
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return targets;
}

/** The targets plus their transitive build-relevant workspace deps. */
function closureOf(packages, targets) {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const selected = new Set();
  const stack = [...targets];
  while (stack.length > 0) {
    const name = stack.pop();
    if (selected.has(name)) continue;
    const pkg = byName.get(name);
    if (pkg === undefined) throw new Error(`--target ${name}: not a workspace package`);
    selected.add(name);
    for (const dep of pkg.deps) if (byName.has(dep)) stack.push(dep);
  }
  return packages.filter((p) => selected.has(p.name));
}

function main() {
  const targets = parseTargets(process.argv.slice(2));
  const all = discoverPackages();
  const packages = targets.length === 0 ? all : closureOf(all, targets);
  const order = topoSort(packages);
  console.log(`\nBuilding ${order.length} workspace packages in prod-dep topological order:\n`);
  for (const pkg of order) {
    console.log(`  ${pkg.name}`);
  }
  console.log('');
  let built = 0;
  let skipped = 0;
  for (const pkg of order) {
    const outcome = buildOne(pkg);
    if (outcome.skipped) {
      skipped++;
      continue;
    }
    if (outcome.code !== 0) {
      console.error(`\n❌ Build failed at ${pkg.name} (exit ${outcome.code}).\n`);
      process.exit(outcome.code);
    }
    built++;
  }
  console.log(`\n✓ Built ${built} packages (${skipped} had no build script).`);
}

try {
  main();
} catch (err) {
  console.error(`build-workspace: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
