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
 * whenever it fails. A file that changed while a build ran (an editor's
 * save landing mid-build, or a write caught half done) may have been read
 * before the change, so that build is compared with nothing: the rebuild
 * the change triggers is always reported (see `stampOf`).
 * Adding or removing a primitive file changes the entry points, so
 * `syncEntries()` recreates the build. When the last primitive file is
 * removed there is nothing for esbuild to build or watch, so the (empty)
 * build is reported directly — the refresh then publishes an empty index.
 *
 * Each build says which packages the code loads from `node_modules`
 * (`externals`), by the same rule as a pack image's bundles. An image
 * bundles the pack's config too, so the config's own are added: it is
 * bundled for them once, as `kindgi dev` reads the config once.
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
import type { ExternalPackage, PackBuild, PackBuilder } from './runners.js';

export interface DevPackBuilderOptions {
  readonly packDir: string;
  /** The pack's discovery patterns. */
  readonly patterns: readonly string[];
  /** The pack's `kindgi.config.*`, whose imports count among the externals. */
  readonly configPath?: string;
}

/** External packages, each with the files importing it (absolute paths). */
type Importers = Map<string, Set<string>>;

/** The build running now: when it started, and the externals it found so far. */
interface BuildRecord {
  readonly startedAt: number;
  readonly importing: Importers;
}

/**
 * How recently an input may have changed before a build's stamp can no
 * longer say what the build read. File times are coarse (a whole second on
 * some file systems) and can trail the clock, so a change within this gap
 * of the build's start may have landed after the build read the file.
 * esbuild's watch mode waits the same 3 s before trusting a file's
 * modification time.
 */
export const STAMP_SAFETY_GAP_MS = 3_000;

export function createDevPackBuilder(options: DevPackBuilderOptions): PackBuilder {
  const outDir = devDistDir(options.packDir);
  let context: BuildContext | undefined;
  let entries: readonly PackEntry[] = [];
  let entriesKey: string | undefined;
  let listener: ((build: PackBuild) => void) | undefined;
  /** What the last reported build read (`stampOf`); undefined compares with nothing. */
  let reportedInputs: string | undefined;
  /** The build running now (a new record per build, read once it ends). */
  let current: BuildRecord = { startedAt: Date.now(), importing: new Map() };
  let configImporting: Promise<Importers> | undefined;

  const configExternals = (): Promise<Importers> => {
    configImporting ??= configExternalsOf(options.packDir, options.configPath);
    return configImporting;
  };
  const externalsOf = async (code: Importers): Promise<readonly ExternalPackage[]> =>
    listExternals([code, await configExternals()], options.packDir);

  /**
   * Each build starts with no externals (`nodeModulesExternalPlugin`
   * records them) and notes when it started. esbuild runs on-start
   * callbacks before it reads any file.
   */
  const collector: Plugin = {
    name: 'kindgi-dev-externals',
    setup(build) {
      build.onStart(() => {
        current = { startedAt: Date.now(), importing: new Map() };
      });
    },
  };

  /** Each build's outcome, for the listener while watching. */
  const reporter: Plugin = {
    name: 'kindgi-dev-build-report',
    setup(build) {
      build.onEnd(async (result) => {
        if (listener === undefined) return;
        const { startedAt, importing } = current;
        const read =
          result.errors.length > 0 ? undefined : await stampOf(result, options.packDir, startedAt);
        if (read !== undefined && read === reportedInputs) return;
        reportedInputs = read;
        const outcome = outcomeOf(result, entries, options.packDir, await externalsOf(importing));
        listener?.(outcome);
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
      plugins: [
        collector,
        nodeModulesExternalPlugin({
          onExternal: (name, importer) => add(current.importing, name, importer),
        }),
        reporter,
      ],
      metafile: true,
      logLevel: 'silent',
    });
    return true;
  }

  return {
    async build() {
      await ensureContext();
      if (context === undefined) {
        return { kind: 'ok', bundleMap: {}, externals: await externalsOf(new Map()) };
      }
      try {
        const result = await context.rebuild();
        const { startedAt, importing } = current;
        reportedInputs = await stampOf(result, options.packDir, startedAt);
        return outcomeOf(result, entries, options.packDir, await externalsOf(importing));
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
        const externals = await externalsOf(new Map());
        listener?.({ kind: 'ok', bundleMap: {}, externals });
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
 * it) mapped to its bundle, both relative to the pack root, and the
 * externals — or the errors, each located `file:line:column`.
 */
function outcomeOf(
  result: BuildResult,
  entries: readonly PackEntry[],
  packDir: string,
  externals: readonly ExternalPackage[],
): PackBuild {
  if (result.errors.length > 0) return failed(result.errors, undefined);
  const bundleMap: Record<string, string> = {};
  const outDir = devDistDir(packDir);
  for (const entry of entries) {
    bundleMap[entry.sourceRel] = toPosix(relative(packDir, `${outDir}/${entry.outRel}.mjs`));
  }
  return { kind: 'ok', bundleMap, externals };
}

/**
 * What the config imports from `node_modules`: bundled in memory, by the
 * externals rule. A config that doesn't bundle adds nothing here (`kindgi
 * build` reports it).
 */
async function configExternalsOf(
  packDir: string,
  configPath: string | undefined,
): Promise<Importers> {
  const found: Importers = new Map();
  if (configPath === undefined) return found;
  const esbuild = await import('esbuild');
  try {
    await esbuild.build({
      absWorkingDir: packDir,
      entryPoints: [configPath],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      logLevel: 'silent',
      plugins: [
        nodeModulesExternalPlugin({ onExternal: (name, importer) => add(found, name, importer) }),
      ],
    });
  } catch {
    return new Map();
  }
  return found;
}

function add(importers: Importers, name: string, importer: string): void {
  const files = importers.get(name) ?? new Set<string>();
  files.add(importer);
  importers.set(name, files);
}

/** The externals, merged, sorted by name; importers relative to the pack root. */
function listExternals(sets: readonly Importers[], packDir: string): ExternalPackage[] {
  const merged: Importers = new Map();
  for (const set of sets) {
    for (const [name, files] of set) for (const file of files) add(merged, name, file);
  }
  return [...merged.keys()].sort().map((name) => ({
    name,
    importers: [...(merged.get(name) ?? [])].map((file) => toPosix(relative(packDir, file))).sort(),
  }));
}

/**
 * What a build read: every input with its size and change times — equal
 * for two builds that read the same files. The files are looked at once
 * the build has ended, so this stands for what it read only when none of
 * them changed after it started. When one did (or changed within
 * `STAMP_SAFETY_GAP_MS` of the start, too close to tell), or is gone,
 * there's no stamp: the build may have read the file before the change,
 * and the rebuild that change triggers would otherwise look the same and
 * go unreported.
 */
export async function stampOf(
  result: Pick<BuildResult, 'metafile'>,
  packDir: string,
  startedAt: number,
): Promise<string | undefined> {
  const inputs = Object.keys(result.metafile?.inputs ?? {}).sort();
  const settledBefore = startedAt - STAMP_SAFETY_GAP_MS;
  const stamped = await Promise.all(
    inputs.map(async (input) => {
      try {
        const s = await stat(resolve(packDir, input));
        if (Math.max(s.mtimeMs, s.ctimeMs) >= settledBefore) return undefined;
        return `${input}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
      } catch {
        return undefined;
      }
    }),
  );
  return stamped.every((line) => line !== undefined) ? stamped.join('\n') : undefined;
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
