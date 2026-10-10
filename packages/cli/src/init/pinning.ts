// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * How `kindgi init` writes a third-party dependency it adds to an app
 * (zod): at the version Kindgi is tested with, written exactly when the
 * app pins exactly or its package manager saves exact versions, else as a
 * `^` range from that version. Kindgi's own packages are always exact
 * (`dependency-specs.ts`).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import semver from 'semver';

/**
 * The zod Kindgi is tested with: the version the workspace resolves.
 * Bump it with each release; a test checks it against the workspace's zod
 * and `@kindgi/sdk`'s zod range.
 */
export const TESTED_ZOD_VERSION = '4.6.5';

/** `version` as an app writes it: exact, or a `^` range from it. */
export function specAt(version: string, exact: boolean): string {
  return exact ? version : `^${version}`;
}

const PINNED_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

/**
 * Whether the app pins exactly: it has at least one semver spec, and every
 * one is an exact version (`1.2.3`, not `^1.2.3`, `~1.2`, `*`). Specs that
 * aren't semver (`workspace:*`, `catalog:`, `file:`, `npm:…`, a git URL, a
 * tag) say nothing either way, and peer ranges are ranges by nature.
 */
export function pinsExactly(pkg: Readonly<Record<string, unknown>>): boolean {
  let exact = 0;
  for (const section of PINNED_SECTIONS) {
    const deps = pkg[section];
    if (deps === null || typeof deps !== 'object') continue;
    for (const spec of Object.values(deps as Record<string, unknown>)) {
      if (typeof spec !== 'string') continue;
      const trimmed = spec.trim();
      if (semver.valid(trimmed) !== null) exact += 1;
      else if (semver.validRange(trimmed) !== null) return false;
    }
  }
  return exact > 0;
}

/**
 * Whether the app's package manager is set to save exact versions:
 * - npm and pnpm: `save-exact=true` or an empty `save-prefix` in the
 *   project's `.npmrc`, else in the user's (`~/.npmrc`), the project's
 *   winning when it sets either;
 * - pnpm: `saveExact: true` or an empty `savePrefix` in `pnpm-workspace.yaml`;
 * - Yarn (2+): an empty `defaultSemverRangePrefix` in `.yarnrc.yml`;
 * - Bun: `exact = true` under `[install]` in `bunfig.toml`.
 * Only those settings are read: nothing else in these files (a registry
 * token, say) is kept or shown.
 */
export async function savesExact(dir: string, home?: string): Promise<boolean> {
  const project = npmrcSaveExact(await readText(join(dir, '.npmrc')));
  if (project !== undefined) return project;
  if (home !== undefined) {
    const user = npmrcSaveExact(await readText(join(home, '.npmrc')));
    if (user !== undefined) return user;
  }
  const pnpm = await readText(join(dir, 'pnpm-workspace.yaml'));
  if (/^\s*saveExact:\s*true\s*$/m.test(pnpm) || /^\s*savePrefix:\s*(''|"")\s*$/m.test(pnpm)) {
    return true;
  }
  const yarn = await readText(join(dir, '.yarnrc.yml'));
  if (/^\s*defaultSemverRangePrefix:\s*(''|"")\s*$/m.test(yarn)) return true;
  return bunInstallExact(await readText(join(dir, 'bunfig.toml')));
}

/** `.npmrc`'s answer: `true`/`false` when it sets `save-exact` or `save-prefix`, else `undefined`. */
function npmrcSaveExact(text: string): boolean | undefined {
  let saveExact: boolean | undefined;
  let savePrefix: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(save-exact|save-prefix)\s*=\s*(.*?)\s*$/.exec(line);
    if (match === null) continue;
    const value = (match[2] ?? '').replace(/^(['"])(.*)\1$/, '$2');
    if (match[1] === 'save-exact') saveExact = value === 'true';
    else savePrefix = value;
  }
  if (saveExact === undefined && savePrefix === undefined) return undefined;
  // `save-exact=true` wins over any prefix; an empty prefix is exact too.
  return saveExact === true || savePrefix === '';
}

/** `exact = true` in `bunfig.toml`'s `[install]` table. */
function bunInstallExact(text: string): boolean {
  let inInstall = false;
  for (const line of text.split(/\r?\n/)) {
    const table = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (table !== null) {
      inInstall = table[1]?.trim() === 'install';
      continue;
    }
    if (inInstall && /^\s*exact\s*=\s*true\s*(#.*)?$/.test(line)) return true;
  }
  return false;
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}
