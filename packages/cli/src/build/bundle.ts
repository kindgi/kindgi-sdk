// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What `kindgi build` and `kindgi dev` share about bundling a pack: the
 * entry points (every file the discovery patterns match), the local
 * source files a build read, and the externals rule: which packages both
 * load from the app's `node_modules`.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createGlobMatcher, discoveryRoots } from '@kindgi/handler-runtime';
import type { Plugin } from 'esbuild';

export interface PackEntry {
  /** Absolute path of the primitive's source file. */
  readonly abs: string;
  /** The source path relative to the pack root — what the index records as `modulePath`. */
  readonly sourceRel: string;
  /** The bundle's path under the output directory, without extension. */
  readonly outRel: string;
}

/**
 * Bundle entrypoints: every file the pack's discovery patterns match
 * (test files excluded), walked from each pattern's static prefix —
 * the same set the indexer discovers, at any depth.
 */
export async function collectPackEntries(
  packDir: string,
  patterns: readonly string[],
): Promise<readonly PackEntry[]> {
  const matches = createGlobMatcher(patterns);
  const out: PackEntry[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(rel === '' ? packDir : join(packDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && matches(child)) {
        out.push({
          abs: join(packDir, child),
          sourceRel: child,
          outRel: child.replace(/\.(ts|mts|mjs|js)$/, ''),
        });
      }
    }
  };
  for (const root of discoveryRoots(patterns)) await walk(root);
  return out.sort((a, b) => a.outRel.localeCompare(b.outRel));
}

/**
 * Local files esbuild read (metafile keys are relative to
 * absWorkingDir): real files outside `node_modules`; plugin namespaces
 * (`ns:…`) are not paths.
 */
export async function localSourceInputs(
  root: string,
  inputs: Readonly<Record<string, unknown>>,
): Promise<string[]> {
  const out: string[] = [];
  for (const key of Object.keys(inputs)) {
    if (key.includes('node_modules/') || /^[a-z-]+:/.test(key)) continue;
    const abs = resolve(root, key);
    if (await isRegularFile(abs)) out.push(abs);
  }
  return out.sort();
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** An ESM bundle that inlines CommonJS code needs `require`. */
export const REQUIRE_BANNER =
  "import { createRequire as __kindgiCreateRequire } from 'node:module'; const require = __kindgiCreateRequire(import.meta.url);";

const SKIP = Symbol('kindgi-externals-resolving');

/**
 * Externals: whatever resolves into a `node_modules` directory stays
 * external — loaded from the pack's own installed dependencies at
 * runtime, native modules and generated clients (Prisma) included.
 * Everything else, the pack's own code, what tsconfig `paths` point at,
 * and a package linked from outside `node_modules` (its real path isn't
 * in one), is bundled.
 *
 * How an external is imported:
 *   - `resolved` (dev): by the absolute path esbuild resolved, so it
 *     loads the same file no matter where the bundle sits;
 *   - `bare` (a pack image): by its specifier, which Node resolves from
 *     the bundle's folder upward into the image's own `node_modules` —
 *     the host's absolute paths don't exist there.
 *
 * Which packages are external doesn't depend on `importBy`: a dev bundle
 * and an image's leave out the same ones. `onExternal` (optional) is told
 * each external import: the package's name (`@scope/name` of
 * `@scope/name/sub`), and the absolute path of the file importing it.
 */
export function nodeModulesExternalPlugin(
  options: {
    readonly importBy?: 'resolved' | 'bare';
    readonly onExternal?: (name: string, importer: string) => void;
  } = {},
): Plugin {
  const importBy = options.importBy ?? 'resolved';
  const onExternal = options.onExternal;
  return {
    name: 'kindgi-node-modules-external',
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, async (args) => {
        if (args.pluginData === SKIP) return undefined;
        const resolved = await build.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          pluginData: SKIP,
        });
        if (resolved.errors.length > 0 || resolved.external) return undefined;
        if (/[\\/]node_modules[\\/]/.test(resolved.path)) {
          onExternal?.(packageName(args.path), args.importer);
          return { path: importBy === 'bare' ? args.path : resolved.path, external: true };
        }
        return undefined;
      });
    },
  };
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}
