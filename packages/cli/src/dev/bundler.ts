// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi dev`'s bundler: every primitive file, with everything it
 * imports, bundled into `.kindgi/dev/dist` by esbuild — so tsconfig
 * `paths` (`@/…`), extensionless imports and the pack's own modules work
 * as they do under the app's own build. What resolves into
 * `node_modules` stays external (see `nodeModulesExternalPlugin`).
 *
 * In watch mode esbuild rebuilds when any file a bundle read changes —
 * not only the discovery folders. A rebuild is reported when the files
 * it read differ from those of the last build reported (so watch mode's
 * own first build, right after `build()`, is not reported twice), and
 * whenever it fails.
 * Adding or removing a primitive file changes the entry points, so
 * `syncEntries()` recreates the build. When the last primitive file is
 * removed there is nothing for esbuild to build or watch, so the (empty)
 * build is reported directly — the refresh then publishes an empty index.
 */

import { stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import type { BuildContext, BuildResult, Message, Plugin } from 'esbuild';

import {
  type PackEntry,
  REQUIRE_BANNER,
  collectPackEntries,
  nodeModulesExternalPlugin,
} from '../build/bundle.js';
import { devDistDir } from './paths.js';
import type { PackBuild, PackBuilder } from './runners.js';

export interface DevPackBuilderOptions {
  readonly packDir: string;
  /** The pack's discovery patterns. */
  readonly patterns: readonly string[];
}

export function createDevPackBuilder(options: DevPackBuilderOptions): PackBuilder {
  const outDir = devDistDir(options.packDir);
  let context: BuildContext | undefined;
  let entries: readonly PackEntry[] = [];
  let entriesKey: string | undefined;
  let listener: ((build: PackBuild) => void) | undefined;
  /** What the last reported build read: each input's path, size and mtime. */
  let reportedInputs: string | undefined;

  /** Each build's outcome, for the listener while watching. */
  const reporter: Plugin = {
    name: 'kindgi-dev-build-report',
    setup(build) {
      build.onEnd(async (result) => {
        if (listener === undefined) return;
        const read = result.errors.length > 0 ? undefined : await inputsOf(result, options.packDir);
        if (read !== undefined && read === reportedInputs) return;
        reportedInputs = read;
        listener(outcomeOf(result, entries, options.packDir));
      });
    },
  };

  /** Recreate the esbuild context when the entry points changed. */
  async function ensureContext(): Promise<boolean> {
    const found = await collectPackEntries(options.packDir, options.patterns);
    const key = JSON.stringify(found.map((e) => e.sourceRel));
    if (context !== undefined && key === entriesKey) return false;
    const esbuild = await import('esbuild');
    await context?.dispose();
    entries = found;
    entriesKey = key;
    context = await esbuild.context({
      absWorkingDir: options.packDir,
      entryPoints: found.map((e) => ({ in: e.abs, out: e.outRel })),
      outdir: outDir,
      outExtension: { '.js': '.mjs' },
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      sourcemap: 'linked',
      banner: { js: REQUIRE_BANNER },
      plugins: [nodeModulesExternalPlugin(), reporter],
      metafile: true,
      logLevel: 'silent',
    });
    return true;
  }

  return {
    async build() {
      await ensureContext();
      if (context === undefined) return { kind: 'ok', bundleMap: {} };
      try {
        const result = await context.rebuild();
        reportedInputs = await inputsOf(result, options.packDir);
        return outcomeOf(result, entries, options.packDir);
      } catch (failure) {
        return failed((failure as { errors?: Message[] }).errors ?? [], failure);
      }
    },

    async watch(onBuild) {
      listener = onBuild;
      await context?.watch();
    },

    async syncEntries() {
      const changed = await ensureContext();
      if (!changed || listener === undefined) return changed;
      if (entries.length === 0) {
        reportedInputs = '';
        listener({ kind: 'ok', bundleMap: {} });
      } else {
        // A new context doesn't watch yet; watching triggers its first build.
        await context?.watch();
      }
      return changed;
    },

    async dispose() {
      listener = undefined;
      await context?.dispose();
      context = undefined;
    },
  };
}

/**
 * A build's outcome: each primitive's source path (as the index records
 * it) mapped to its bundle, both relative to the pack root — or the
 * errors, each located `file:line:column`.
 */
function outcomeOf(result: BuildResult, entries: readonly PackEntry[], packDir: string): PackBuild {
  if (result.errors.length > 0) return failed(result.errors, undefined);
  const bundleMap: Record<string, string> = {};
  const outDir = devDistDir(packDir);
  for (const entry of entries) {
    bundleMap[entry.sourceRel] = toPosix(relative(packDir, `${outDir}/${entry.outRel}.mjs`));
  }
  return { kind: 'ok', bundleMap };
}

/** Every file a build read, with its size and mtime — equal when nothing changed. */
async function inputsOf(result: BuildResult, packDir: string): Promise<string> {
  const inputs = Object.keys(result.metafile?.inputs ?? {}).sort();
  const stamped = await Promise.all(
    inputs.map(async (input) => {
      try {
        const s = await stat(resolve(packDir, input));
        return `${input}:${s.size}:${s.mtimeMs}`;
      } catch {
        return `${input}:-`;
      }
    }),
  );
  return stamped.join('\n');
}

function failed(errors: readonly Message[], cause: unknown): PackBuild {
  const located = errors.map((e) =>
    e.location === null
      ? e.text
      : `${e.location.file}:${e.location.line}:${e.location.column}: ${e.text}`,
  );
  return {
    kind: 'err',
    errors: located.length > 0 ? located : [cause instanceof Error ? cause.message : String(cause)],
  };
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}
