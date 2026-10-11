// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The test setup augment-mode `kindgi init` gives an app, so `kindgi test`
 * runs the tests beside its Kindgi primitives: `vitest` and `vite`
 * (vitest's peer, which it doesn't install) in devDependencies, and a
 * vitest config at the app's root (`vitest.config.mts`, `.ts` in a
 * `"type": "module"` app) that runs the `.test.ts` files under `kindgi/`
 * with the app's tsconfig path aliases. An app that runs vitest already keeps its own
 * setup, and init says what `kindgi test` needs from it.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import semver from 'semver';
import { VITEST_CONFIG_FILENAMES } from '../test/runners.js';
import type { WantedDependency } from './package-json-patcher.js';

import {
  TESTED_VITEST_VERSION,
  TESTED_VITE_VERSION,
  VITEST_VITE_RANGE,
  specAt,
} from './pinning.js';
import { type PathAlias, readTsconfigPaths } from './tsconfig-paths.js';

/** What `kindgi test` runs in an app Kindgi was added to. */
export const KINDGI_TESTS_GLOB = 'kindgi/**/*.test.ts';

/** The first line of the config init writes: how a later init knows the file is its own. */
const HEADER = '// The vitest config for the tests beside your Kindgi primitives, added by';

export type VitestSetup =
  | {
      /** Write (or, with --force, rewrite) init's config, and add what it needs. */
      readonly kind: 'write';
      readonly path: string;
      readonly contents: string;
      readonly dependencies: readonly WantedDependency[];
      readonly aliases: readonly PathAlias[];
      readonly notes: readonly string[];
    }
  | {
      /** init's own config from an earlier run, kept (no --force). */
      readonly kind: 'kept';
      readonly path: string;
    }
  | {
      /** The app's own vitest setup, left as is; the warning says what `kindgi test` needs. */
      readonly kind: 'app-owned';
      readonly warning: string;
    };

const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/**
 * What to do about the app's tests:
 * - a vitest config init wrote before: rewritten with --force (its aliases
 *   read again), else kept;
 * - the app's own `vitest.config.*`, or vitest without one (`vite.config.*`
 *   or vitest's defaults): left as is, with a warning;
 * - else init's config, with vitest and vite pinned as the app pins.
 */
export async function planVitestSetup(args: {
  readonly targetDir: string;
  readonly pkg: Readonly<Record<string, unknown>>;
  /** The app is `"type": "module"`: the config is `.ts`, else `.mts`. */
  readonly esmApp: boolean;
  /** Write exact versions (the app pins exactly, or saves exact). */
  readonly exact: boolean;
  readonly force: boolean;
}): Promise<VitestSetup> {
  for (const name of VITEST_CONFIG_FILENAMES) {
    const path = join(args.targetDir, name);
    const text = await readText(path);
    if (text === undefined) continue;
    if (text.startsWith(HEADER)) {
      if (!args.force) return { kind: 'kept', path };
      return write(args, path);
    }
    return {
      kind: 'app-owned',
      warning: `vitest: the app's own ${name} is left as is, and kindgi test runs it: its test.include needs '${KINDGI_TESTS_GLOB}', and its resolve.alias the tsconfig paths Kindgi's code imports by.`,
    };
  }
  if (hasDependency(args.pkg, 'vitest')) {
    return {
      kind: 'app-owned',
      warning: `vitest: the app runs vitest without a vitest.config.* (on vite.config.* or vitest's defaults), left as is. kindgi test needs one: a vitest.config.${args.esmApp ? 'ts' : 'mts'} whose test.include has '${KINDGI_TESTS_GLOB}' beside the app's own tests (vitest then reads it instead of vite.config.*).`,
    };
  }
  return write(args, join(args.targetDir, args.esmApp ? 'vitest.config.ts' : 'vitest.config.mts'));
}

async function write(
  args: {
    readonly targetDir: string;
    readonly pkg: Readonly<Record<string, unknown>>;
    readonly exact: boolean;
  },
  path: string,
): Promise<VitestSetup> {
  const paths = await readTsconfigPaths(args.targetDir);
  const notes = [...viteWarnings(args.pkg), ...paths.notes];
  const { aliases } = paths;
  return {
    kind: 'write',
    path,
    contents: renderVitestConfig(aliases),
    dependencies: [
      {
        name: 'vitest',
        spec: specAt(TESTED_VITEST_VERSION, args.exact),
        section: 'devDependencies',
      },
      { name: 'vite', spec: specAt(TESTED_VITE_VERSION, args.exact), section: 'devDependencies' },
    ],
    aliases,
    notes,
  };
}

/** The config init writes: Kindgi's tests only, with the app's path aliases. */
export function renderVitestConfig(aliases: readonly PathAlias[]): string {
  const lines = [
    HEADER,
    '// `kindgi init`: `kindgi test` runs it.',
    ...(aliases.length > 0
      ? ["import { dirname } from 'node:path';", "import { fileURLToPath } from 'node:url';", '']
      : []),
    "import { defineConfig } from 'vitest/config';",
    '',
    ...(aliases.length > 0 ? ['const root = dirname(fileURLToPath(import.meta.url));', ''] : []),
    'export default defineConfig({',
    ...(aliases.length > 0
      ? [
          '  resolve: {',
          "    // tsconfig.json's paths, which vitest doesn't read, as `kindgi init`",
          '    // found them: when you change those, change these to match.',
          '    alias: [',
          ...aliases.map(
            (a) => `      { find: ${aliasFind(a.pattern)}, replacement: ${aliasReplacement(a)} },`,
          ),
          '    ],',
          '  },',
        ]
      : []),
    '  test: {',
    `    include: ['${KINDGI_TESTS_GLOB}'],`,
    '    passWithNoTests: true,',
    '  },',
    '});',
    '',
  ];
  return lines.join('\n');
}

/** A tsconfig pattern as a regex literal: an exact name, or `prefix*suffix` capturing the `*`. */
function aliasFind(pattern: string): string {
  const star = pattern.indexOf('*');
  if (star === -1) return `/^${escapeRegex(pattern)}$/`;
  return `/^${escapeRegex(pattern.slice(0, star))}(.*)${escapeRegex(pattern.slice(star + 1))}$/`;
}

/** The target from the config's folder, as a template literal, with the `*` as the capture. */
function aliasReplacement(alias: PathAlias): string {
  const escaped = alias.target.replace(/[`\\]/g, '\\$&').replace(/\$\{/g, '\\${');
  const target = alias.pattern.includes('*') ? escaped.replace('*', '$1') : escaped;
  return target === '.' ? '`${root}`' : `\`\${root}/${target}\``;
}

/**
 * The app's own vite is kept; one outside vitest's peer range is reported,
 * since installing vitest then fails on its peer. A spec that isn't a
 * semver range is taken on trust.
 */
function viteWarnings(pkg: Readonly<Record<string, unknown>>): readonly string[] {
  for (const section of DEPENDENCY_SECTIONS) {
    const deps = pkg[section];
    if (deps === null || typeof deps !== 'object') continue;
    const spec = (deps as Record<string, unknown>).vite;
    if (typeof spec !== 'string') continue;
    if (semver.validRange(spec) === null || semver.intersects(spec, VITEST_VITE_RANGE)) return [];
    return [
      `vite: the app has vite ${spec} (${section}), left as is. vitest ${TESTED_VITEST_VERSION}, which kindgi test runs, needs vite ${VITEST_VITE_RANGE}: upgrade vite before installing, or the install stops on vitest's peer.`,
    ];
  }
  return [];
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function hasDependency(pkg: Readonly<Record<string, unknown>>, name: string): boolean {
  return DEPENDENCY_SECTIONS.some((section) => {
    const deps = pkg[section];
    return deps !== null && typeof deps === 'object' && name in deps;
  });
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}
