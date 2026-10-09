#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * No dependency cycles between this repository's workspace packages.
 * pnpm orders `pnpm -r` and `pnpm --filter '<pkg>...'` by every declared
 * dependency, devDependencies included; packages in a cycle run in an
 * arbitrary order, so a fresh checkout's build can try a package before
 * the one it imports is built. A test-only devDependency is enough to make
 * one: a helper a package's own tests need belongs in that package (or one
 * below it), never in a package that depends on it (as `@kindgi/api`'s
 * stub bindings live in `@kindgi/api/testing`, which `@kindgi/testing`
 * re-exports).
 *
 * This reads every package from `pnpm-workspace.yaml`'s entries (`<dir>/*`
 * globs and plain `<dir>`s) and fails on each cycle, printed as a path with
 * the kind of each edge. The same check runs in the runtime's repository.
 *
 * Usage: `pnpm run check:cycles` (CI's lint job runs it).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The manifest fields whose packages pnpm orders by. */
export const DEPENDENCY_KINDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/** This repository's workspace packages: name → manifest. */
export function localPackages(root = ROOT) {
  // The `packages:` list: its `- "<glob>"` lines, up to the next top-level key.
  const lines = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8').split('\n');
  const start = lines.findIndex((l) => /^packages:\s*$/.test(l));
  const globs = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const glob = /^\s*-\s*["']?([^"'#\s]+)["']?/.exec(line)?.[1];
    if (glob !== undefined && !glob.startsWith('..')) globs.push(glob);
  }
  const byName = new Map();
  const add = (manifest) => {
    if (!existsSync(manifest)) return;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (typeof pkg.name === 'string') byName.set(pkg.name, pkg);
  };
  for (const glob of globs) {
    if (!glob.includes('*')) {
      add(join(root, glob, 'package.json'));
      continue;
    }
    if (!glob.endsWith('/*') || glob.slice(0, -2).includes('*')) {
      throw new Error(`pnpm-workspace.yaml: can't expand "${glob}" (only "<dir>/*" or "<dir>")`);
    }
    const base = join(root, glob.slice(0, -2));
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) add(join(base, entry.name, 'package.json'));
    }
  }
  return byName;
}

/**
 * Every cycle among `packages` (name → manifest), one per strongly
 * connected component: `[{ path: [a, b, …, a], kinds: [kind of a→b, …] }]`,
 * sorted by first name. A package naming itself is ignored.
 */
export function findCycles(packages) {
  const edges = new Map();
  for (const [name, pkg] of packages) {
    const out = new Map();
    for (const kind of DEPENDENCY_KINDS) {
      for (const dep of Object.keys(pkg[kind] ?? {}).sort()) {
        if (dep !== name && packages.has(dep) && !out.has(dep)) out.set(dep, kind);
      }
    }
    edges.set(name, out);
  }

  // Tarjan's strongly connected components, iteratively.
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let next = 0;
  for (const root of [...edges.keys()].sort()) {
    if (index.has(root)) continue;
    const work = [[root, [...edges.get(root).keys()], 0]];
    index.set(root, next);
    low.set(root, next);
    next += 1;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const [v, succ] = frame;
      if (frame[2] < succ.length) {
        const w = succ[frame[2]];
        frame[2] += 1;
        if (!index.has(w)) {
          index.set(w, next);
          low.set(w, next);
          next += 1;
          stack.push(w);
          onStack.add(w);
          work.push([w, [...edges.get(w).keys()], 0]);
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), index.get(w)));
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(v)));
      }
      if (low.get(v) === index.get(v)) {
        const component = [];
        let w;
        do {
          w = stack.pop();
          onStack.delete(w);
          component.push(w);
        } while (w !== v);
        if (component.length > 1) components.push(component);
      }
    }
  }

  // One concrete cycle per component: from its first name, the shortest
  // way back to it inside the component.
  return components
    .map((component) => {
      const members = new Set(component);
      const start = [...members].sort()[0];
      const previous = new Map([[start, undefined]]);
      const queue = [start];
      let back;
      while (queue.length > 0 && back === undefined) {
        const v = queue.shift();
        for (const w of edges.get(v).keys()) {
          if (!members.has(w)) continue;
          if (w === start) {
            back = v;
            break;
          }
          if (!previous.has(w)) {
            previous.set(w, v);
            queue.push(w);
          }
        }
      }
      const path = [start];
      for (let v = back; v !== start; v = previous.get(v)) path.splice(1, 0, v);
      path.push(start);
      const kinds = path.slice(0, -1).map((v, i) => edges.get(v).get(path[i + 1]));
      return { path, kinds };
    })
    .sort((a, b) => a.path[0].localeCompare(b.path[0]));
}

function main() {
  const packages = localPackages();
  const cycles = findCycles(packages);
  if (cycles.length > 0) {
    console.error(`check:cycles: ${cycles.length} package cycle(s):\n`);
    for (const { path, kinds } of cycles) {
      const steps = path.slice(1).map((name, i) => ` -(${kinds[i]})-> ${name}`);
      console.error(`  ${path[0]}${steps.join('')}`);
    }
    console.error(
      "\npnpm builds a cycle's packages in an arbitrary order, so a fresh checkout can fail." +
        "\nA helper a package's own tests need goes in that package or below it, never in one" +
        ' that depends on it (see @kindgi/api/testing).',
    );
    process.exit(1);
  }
  console.log(`check:cycles: ${packages.size} packages: no dependency cycles.`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
