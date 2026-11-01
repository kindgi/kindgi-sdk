// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * workspace-source-aliases: a package's workspace dependencies, loaded from
 * their TypeScript source by vite (vitest, or a script on vite's server).
 *
 * Every workspace package exports its built `./dist/*.js` only, so code
 * that imports `@kindgi/types` loads whatever `pnpm run build` last wrote:
 * nothing in a fresh worktree, and an older build in one where a
 * dependency's source changed since. A vite or vitest config that sets
 *
 *   resolve: { alias: workspaceSourceAliases(<the package's directory>) }
 *
 * loads the commit's own code instead, with no build first.
 *
 * Which packages: the package itself (a dependency may import it by name),
 * its `workspace:` dependencies and devDependencies, and their `workspace:`
 * dependencies, transitively. A dependency's devDependencies aren't loaded
 * by the package's tests, so they're not followed.
 *
 * Which entries: each export whose target is `./dist/<path>.js` gets an
 * alias for exactly its specifier (`@kindgi/api` never matches
 * `@kindgi/api/testing`), replaced by `<package>/src/<path>.ts`. An
 * `exports` string, or an object of conditions only, is the `.` export, as
 * in Node. An export
 * with no `./dist/` target (a committed `./openapi.json`, `./schemas/*`)
 * has no alias and resolves as it always does. These throw, naming the
 * package and the export, so nothing loads `dist/` without saying so:
 *
 * - a `./dist/` target with no source file;
 * - a `./dist/` subpath pattern;
 * - an export whose `./dist/` targets include no `.js` file
 *   (`./dist/index.cjs`, `./dist/*`);
 * - a package with no `exports` whose `main` or `module` is in `dist/`.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const DIST_PATH = /^(\.\/)?dist\//;
const DIST_TARGET = /^\.\/dist\/(.+)\.js$/;

/**
 * @typedef {{ find: RegExp, replacement: string }} Alias
 *   vite's `resolve.alias` entry: `find` matches the whole specifier.
 */

/**
 * @param {string} packageDir the package whose code loads from source
 * @returns {Alias[]} one alias per `./dist/` export of each package loaded
 */
export function workspaceSourceAliases(packageDir) {
  const aliases = [];
  const seen = new Set();
  const queue = [{ dir: realpathSync(packageDir), withDev: true }];
  while (queue.length > 0) {
    const { dir, withDev } = /** @type {{ dir: string, withDev: boolean }} */ (queue.shift());
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (seen.has(manifest.name)) continue;
    seen.add(manifest.name);
    aliases.push(...exportAliases(dir, manifest));
    for (const name of workspaceDeps(manifest, withDev)) {
      const linked = join(dir, 'node_modules', name);
      if (!existsSync(linked)) {
        throw new Error(
          `${manifest.name} depends on ${name}, which isn't linked at ${linked}: run pnpm install`,
        );
      }
      queue.push({ dir: realpathSync(linked), withDev: false });
    }
  }
  return aliases;
}

/**
 * @param {Record<string, unknown>} manifest
 * @param {boolean} withDev
 * @returns {string[]} the names of the manifest's `workspace:` dependencies
 */
function workspaceDeps(manifest, withDev) {
  const groups = [manifest.dependencies, withDev ? manifest.devDependencies : undefined];
  return groups.flatMap((group) =>
    Object.entries(/** @type {Record<string, string>} */ (group ?? {}))
      .filter(([, spec]) => spec.startsWith('workspace:'))
      .map(([name]) => name),
  );
}

/**
 * @param {string} dir
 * @param {{ name: string, exports?: unknown, main?: unknown, module?: unknown }} manifest
 * @returns {Alias[]}
 */
function exportAliases(dir, manifest) {
  if (manifest.exports == null) {
    checkEntryPointsOutsideDist(manifest);
    return [];
  }
  const { exports } = manifest;
  // A string, or an object with no `.` key (conditions only), is Node's shorthand for `.`.
  const entries =
    typeof exports === 'string' || !Object.keys(exports).some((key) => key.startsWith('.'))
      ? { '.': exports }
      : exports;
  return Object.entries(entries).flatMap(([subpath, target]) => {
    const name = `${manifest.name}${subpath === '.' ? '' : subpath.slice(1)}`;
    return exportAlias(dir, name, subpath, target);
  });
}

/**
 * A package with no `exports` is resolved by its `main` or `module`, which
 * gets no alias: one in `dist/` throws.
 *
 * @param {{ name: string, main?: unknown, module?: unknown }} manifest
 */
function checkEntryPointsOutsideDist(manifest) {
  for (const field of /** @type {const} */ (['main', 'module'])) {
    const target = manifest[field];
    if (typeof target === 'string' && DIST_PATH.test(target)) {
      throw new Error(
        `${manifest.name} has no exports, and its ${field} ${target} is in dist/, which has no source alias`,
      );
    }
  }
}

/**
 * @param {string} dir
 * @param {string} name the export's specifier
 * @param {string} subpath
 * @param {unknown} target
 * @returns {Alias[]} its alias, or none for an export with no `./dist/` target
 */
function exportAlias(dir, name, subpath, target) {
  const distTargets = [...new Set(runtimeTargets(target))].filter((t) => DIST_PATH.test(t));
  if (distTargets.length === 0) return [];
  const jsTargets = distTargets.filter((t) => DIST_TARGET.test(t));
  if (jsTargets.length === 0) {
    throw new Error(
      `${name} exports ${distTargets.join(', ')}, with no ./dist/<path>.js target to alias to its source`,
    );
  }
  if (jsTargets.length > 1) {
    throw new Error(`${name} has more than one ./dist/ .js target: ${jsTargets.join(', ')}`);
  }
  if (subpath.includes('*')) {
    throw new Error(`${name} is a ./dist/ subpath pattern, which has no source alias`);
  }
  const source = join(dir, 'src', `${DIST_TARGET.exec(jsTargets[0])?.[1]}.ts`);
  if (!existsSync(source)) {
    throw new Error(`${name} exports ${jsTargets[0]}, which has no source at ${source}`);
  }
  return [
    { find: new RegExp(`^${escapeRegExp(name)}$`), replacement: source.replaceAll('$', '$$$$') },
  ];
}

/**
 * @param {unknown} target an export's target: a path, or conditions
 * @returns {string[]} the paths code loads: every condition's but `types`
 */
function runtimeTargets(target) {
  if (typeof target === 'string') return [target];
  if (typeof target !== 'object' || target === null) return [];
  return Object.entries(target).flatMap(([condition, value]) =>
    condition === 'types' ? [] : runtimeTargets(value),
  );
}

/** @param {string} text */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
