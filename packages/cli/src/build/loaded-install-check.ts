// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The check on a lockfile cut down to what the pack loads
 * (`loaded-install.ts`), against the app's own: the image's install must
 * keep the app's pins. Every entry of the cut-down lockfile must be the
 * app's entry for that package, the same version, resolution and
 * integrity; nothing in it may be missing from the app's. And every
 * package the cut-down manifest installs as a production dependency must
 * be in the app's production graph, so the image never ships what the app
 * has only for development.
 *
 * It reads both lockfiles itself and shares no code with the reducer, so a
 * reducer bug can't pass its own output. The package manager's own
 * supply-chain settings (pnpm's minimumReleaseAge, trustPolicy, allowBuilds)
 * apply to the cut-down install unchanged: the workspace file goes along.
 */

import { isDeepStrictEqual } from 'node:util';

import { parseAllDocuments } from 'yaml';

import type { ImagePackageManager } from './host-install.js';

export interface ReducedLockfileCheck {
  readonly manager: ImagePackageManager;
  /** The pack folder relative to the install root (`''` at the root). */
  readonly packRel: string;
  /** The app's lockfile, and the cut-down one, as text. */
  readonly lockfile: string;
  readonly reduced: string;
  /** The cut-down `package.json`, as text. */
  readonly manifest: string;
  readonly rootManifest: Readonly<Record<string, unknown>>;
  readonly packManifest: Readonly<Record<string, unknown>>;
}

export type ReducedLockfileOutcome =
  | { readonly kind: 'ok' }
  | { readonly kind: 'refused'; readonly message: string };

type Json = Readonly<Record<string, unknown>>;

/** Whether the cut-down lockfile keeps the app's pins (`ReducedLockfileCheck`). */
export function checkReducedLockfile(check: ReducedLockfileCheck): ReducedLockfileOutcome {
  let manifest: Json;
  try {
    manifest = record(JSON.parse(check.manifest));
  } catch {
    return refused("the cut-down package.json isn't JSON");
  }
  switch (check.manager) {
    case 'pnpm':
      return checkPnpm(check, manifest);
    case 'npm':
      return checkNpm(check, manifest);
    case 'yarn':
      return checkYarnClassic(check, manifest);
  }
}

// ---------------------------------------------------------------------
// pnpm
// ---------------------------------------------------------------------

function checkPnpm(check: ReducedLockfileCheck, manifest: Json): ReducedLockfileOutcome {
  const app = pnpmDocuments(check.lockfile);
  const cut = pnpmDocuments(check.reduced);
  if (app === undefined || cut === undefined) return refused("a lockfile isn't pnpm's YAML");
  if (app.length !== cut.length) return refused('the env document differs');
  for (let i = 0; i < app.length - 1; i++) {
    if (!isDeepStrictEqual(app[i], cut[i])) return refused('the env document differs');
  }
  const appLock = app[app.length - 1] ?? {};
  const cutLock = cut[cut.length - 1] ?? {};

  for (const key of new Set([...Object.keys(appLock), ...Object.keys(cutLock)])) {
    if (['importers', 'packages', 'snapshots', 'patchedDependencies'].includes(key)) continue;
    if (!isDeepStrictEqual(appLock[key], cutLock[key]))
      return refused(`its ${key} differs from the app's`);
  }
  for (const section of ['packages', 'snapshots', 'patchedDependencies']) {
    const ours = record(appLock[section]);
    for (const [key, entry] of Object.entries(record(cutLock[section]))) {
      if (!Object.hasOwn(ours, key))
        return refused(`${section} has ${key}, which the app's lockfile doesn't`);
      if (!isDeepStrictEqual(ours[key], entry))
        return refused(`${section} ${key} differs from the app's`);
    }
  }

  const importers = record(cutLock.importers);
  const extra = Object.keys(importers).filter((key) => key !== '.');
  if (extra.length > 0)
    return refused(`it has importer ${extra[0]}, and the image installs one project`);
  const appImporters = record(appLock.importers);
  const packImporters = check.packRel === '' ? ['.'] : [check.packRel, '.'];
  const snapshots = record(appLock.snapshots);
  const keyOf = (name: string, version: string): string =>
    !/^[a-z+]+:/.test(version) && stem(version).indexOf('@', 1) > 0
      ? version
      : `${name}@${version}`;
  const graph = (fields: readonly string[]): Set<string> => {
    const seen = new Set<string>();
    const todo = packImporters.flatMap((importer) =>
      fields.flatMap((field) =>
        Object.entries(record(record(appImporters[importer])[field])).map(([name, dep]) =>
          keyOf(name, String(record(dep).version)),
        ),
      ),
    );
    for (let key = todo.pop(); key !== undefined; key = todo.pop()) {
      if (seen.has(key)) continue;
      seen.add(key);
      const snapshot = record(snapshots[key]);
      for (const field of ['dependencies', 'optionalDependencies']) {
        for (const [name, version] of Object.entries(record(snapshot[field])))
          todo.push(keyOf(name, String(version)));
      }
    }
    return seen;
  };
  const production = graph(['dependencies', 'optionalDependencies']);
  const everything = graph(['dependencies', 'optionalDependencies', 'devDependencies']);
  const cutImporter = record(importers['.']);
  for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
    const listed = record(manifest[field]);
    const locked = record(cutImporter[field]);
    for (const [name, dep] of Object.entries(locked)) {
      const key = keyOf(name, String(record(dep).version));
      if (listed[name] !== record(dep).specifier)
        return refused(`${name}'s specifier isn't the cut-down package.json's`);
      const allowed = field === 'devDependencies' ? everything : production;
      if (!allowed.has(key)) {
        return refused(
          field === 'devDependencies'
            ? `${key} isn't in the app's dependency graph`
            : `${key} isn't in the app's production dependencies`,
        );
      }
    }
    for (const name of Object.keys(listed)) {
      if (!Object.hasOwn(locked, name))
        return refused(`the cut-down package.json has ${name}, which its lockfile doesn't`);
    }
  }
  return { kind: 'ok' };
}

function pnpmDocuments(text: string): Json[] | undefined {
  const docs = parseAllDocuments(text);
  if (!Array.isArray(docs) || docs.some((doc) => doc.errors.length > 0)) return undefined;
  return docs.map((doc) => record(doc.toJS()));
}

/** A snapshot key or version, without its peer and patch suffixes. */
function stem(value: string): string {
  const paren = value.indexOf('(');
  return paren === -1 ? value : value.slice(0, paren);
}

// ---------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------

/** The flags the cut-down lockfile recomputes for its own tree. */
const NPM_FLAGS = ['dev', 'optional', 'devOptional', 'peer'];

function checkNpm(check: ReducedLockfileCheck, manifest: Json): ReducedLockfileOutcome {
  let app: Json;
  let cut: Json;
  try {
    app = record(JSON.parse(check.lockfile));
    cut = record(JSON.parse(check.reduced));
  } catch {
    return refused("a lockfile isn't JSON");
  }
  if (app.lockfileVersion !== cut.lockfileVersion) return refused('its lockfileVersion differs');
  const appEntries = record(app.packages);
  const without = (entry: unknown): Json =>
    Object.fromEntries(
      Object.entries(record(entry)).filter(([field]) => !NPM_FLAGS.includes(field)),
    );

  for (const [path, entry] of Object.entries(record(cut.packages))) {
    if (path === '') continue;
    // A pack in a workspace member: its own nested packages move to the root's node_modules.
    const candidates = [path, ...(check.packRel === '' ? [] : [`${check.packRel}/${path}`])];
    const match = candidates.find(
      (candidate) =>
        Object.hasOwn(appEntries, candidate) &&
        isDeepStrictEqual(without(appEntries[candidate]), without(entry)),
    );
    if (match === undefined) {
      return candidates.some((candidate) => Object.hasOwn(appEntries, candidate))
        ? refused(`${path} differs from the app's`)
        : refused(`it has ${path}, which the app's lockfile doesn't`);
    }
    if (record(entry).dev !== true && record(appEntries[match]).dev === true) {
      return refused(`${match} is only a dev dependency of the app`);
    }
  }

  const root = record(record(cut.packages)['']);
  for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
    if (!isDeepStrictEqual(record(root[field]), record(manifest[field]))) {
      return refused(`its ${field} aren't the cut-down package.json's`);
    }
  }
  return { kind: 'ok' };
}

// ---------------------------------------------------------------------
// yarn 1
// ---------------------------------------------------------------------

function checkYarnClassic(check: ReducedLockfileCheck, manifest: Json): ReducedLockfileOutcome {
  const app = yarnEntries(check.lockfile);
  const cut = yarnEntries(check.reduced);
  const appTexts = new Set(app.map((entry) => entry.text));
  for (const entry of cut) {
    if (!appTexts.has(entry.text)) {
      return app.some((ours) => ours.keys.some((key) => entry.keys.includes(key)))
        ? refused(`${entry.keys[0]} differs from the app's`)
        : refused(`it has ${entry.keys[0]}, which the app's lockfile doesn't`);
    }
  }

  // The app's production graph: the pack project's (and, for a pack in a member, the root's) production dependencies.
  const byKey = new Map(app.flatMap((entry) => entry.keys.map((key) => [key, entry] as const)));
  const manifests =
    check.packRel === '' ? [check.rootManifest] : [check.packManifest, check.rootManifest];
  const production = new Set<YarnEntry>();
  const todo = manifests.flatMap((m) =>
    ['dependencies', 'optionalDependencies'].flatMap((field) =>
      Object.entries(record(m[field])).map(([name, range]) => `${name}@${String(range)}`),
    ),
  );
  for (let key = todo.pop(); key !== undefined; key = todo.pop()) {
    const entry = byKey.get(key);
    if (entry === undefined || production.has(entry)) continue;
    production.add(entry);
    todo.push(...entry.dependencies);
  }
  const cutKeys = new Map(cut.flatMap((entry) => entry.keys.map((key) => [key, entry] as const)));
  for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(record(manifest[field]))) {
      const key = `${name}@${String(range)}`;
      const entry = cutKeys.get(key);
      if (entry === undefined)
        return refused(`the cut-down package.json has ${key}, which its lockfile doesn't`);
      const ours = byKey.get(key);
      if (field !== 'devDependencies' && (ours === undefined || !production.has(ours))) {
        return refused(`${key} isn't in the app's production dependencies`);
      }
    }
  }
  return { kind: 'ok' };
}

interface YarnEntry {
  readonly text: string;
  readonly keys: readonly string[];
  /** `name@range` of each dependency and optional dependency. */
  readonly dependencies: readonly string[];
}

function yarnEntries(text: string): YarnEntry[] {
  const unquote = (value: string): string => value.replace(/^"(.*)"$/, '$1');
  return text
    .split(/\n\s*\n/)
    .map((chunk) => chunk.split('\n').filter((line) => line !== '' && !line.startsWith('#')))
    .filter((lines) => lines[0] !== undefined && !lines[0].startsWith(' '))
    .map((lines) => ({
      text: lines.join('\n'),
      keys: (lines[0] ?? '')
        .replace(/:$/, '')
        .split(/,\s*/)
        .map((key) => unquote(key.trim())),
      dependencies: lines
        .filter((line) => line.startsWith('    '))
        .map((line) => /^\s+("[^"]+"|\S+)\s+(.+)$/.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => `${unquote(match[1] ?? '')}@${unquote(match[2] ?? '')}`),
    }));
}

function record(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function refused(message: string): ReducedLockfileOutcome {
  return { kind: 'refused', message };
}
