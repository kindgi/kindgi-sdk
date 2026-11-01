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
 * `@kindgi/api/testing`), replaced by `<package>/src/<path>.ts`. An export
 * with any other target (a committed `./openapi.json`, `./schemas/*`) has
 * no alias and resolves as it always does. A `./dist/` target with no
 * source file, or a `./dist/` subpath pattern, throws, naming the package
 * and the export: an alias is never left out, so nothing loads `dist/`
 * without saying so.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

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
 * @param {{ name: string, exports?: unknown }} manifest
 * @returns {Alias[]}
 */
function exportAliases(dir, manifest) {
  const entries =
    typeof manifest.exports === 'string' ? { '.': manifest.exports } : manifest.exports;
  const aliases = [];
  for (const [subpath, target] of Object.entries(entries ?? {})) {
    const distTargets = [...new Set(jsTargets(target))].filter((t) => DIST_TARGET.test(t));
    if (distTargets.length === 0) continue;
    const name = `${manifest.name}${subpath === '.' ? '' : subpath.slice(1)}`;
    if (distTargets.length > 1) {
      throw new Error(`${name} has more than one ./dist/ target: ${distTargets.join(', ')}`);
    }
    if (subpath.includes('*')) {
      throw new Error(`${name} is a ./dist/ subpath pattern, which has no source alias`);
    }
    const source = join(dir, 'src', `${DIST_TARGET.exec(distTargets[0])?.[1]}.ts`);
    if (!existsSync(source)) {
      throw new Error(`${name} exports ${distTargets[0]}, which has no source at ${source}`);
    }
    aliases.push({
      find: new RegExp(`^${escapeRegExp(name)}$`),
      replacement: source.replaceAll('$', '$$$$'),
    });
  }
  return aliases;
}

/**
 * @param {unknown} target an export's target: a path, or conditions
 * @returns {string[]} its JavaScript targets, every condition but `types`
 */
function jsTargets(target) {
  if (typeof target === 'string') return [target];
  if (typeof target !== 'object' || target === null) return [];
  return Object.entries(target).flatMap(([condition, value]) =>
    condition === 'types' ? [] : jsTargets(value),
  );
}

/** @param {string} text */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
