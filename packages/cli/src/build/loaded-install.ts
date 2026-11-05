// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `image.dependencies: 'loaded'`: the image's install downloads only what
 * the pack loads, from a manifest and lockfile cut down to it here, on the
 * host. The rest of the app's production install (its framework, its ORM,
 * its image libraries) is never downloaded.
 *
 * The roots:
 *   - the packages the bundles import by name (`externals.json`),
 *     `image.keep`, and the extensions' keeps that are installed, each
 *     where Node finds it from the pack folder, as the image will;
 *   - the build steps' tools: the dependency whose bin a step runs.
 * Everything below the roots comes from the lockfile: their dependencies
 * and optional dependencies, with peers as the lockfile resolved them.
 * Optional platform packages are kept for every platform the lockfile
 * lists, so the image's install picks its own.
 *
 * The cut-down lockfile copies each entry verbatim (version, resolution,
 * integrity), so the image installs it frozen with the usual commands, and
 * `checkReducedLockfile` checks it against the app's before the build goes
 * on. The install is one project at `/app`; the pack's own manifest stays
 * at `/app/<packRel>`, its install scripts left out.
 *
 * The full production install, trimmed after, stays where a cut-down
 * lockfile can't install frozen (`fallback`, with the reason): yarn berry,
 * a lockfile version this doesn't know, a local package (`link:`, `file:`,
 * `workspace:`) among what the pack loads. A package whose installed
 * folder doesn't match the lockfile fails the build (`err`): node_modules
 * is out of date with it, so the host build used code the lockfile doesn't
 * pin.
 */

import type { Dirent } from 'node:fs';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { satisfies, validRange } from 'semver';
import { isMap, isScalar, parseDocument } from 'yaml';

import type { HostInstall, ImagePackageManager, ReducedInstall } from './host-install.js';
import type { ResolvedImage } from './image-config.js';
import { checkReducedLockfile } from './loaded-install-check.js';

/** A package as the host has it installed. */
export interface HostPackage {
  readonly name: string;
  /** Its folder's real path, relative to the install root (`node_modules/.pnpm/chalk@4.1.2/node_modules/chalk`). */
  readonly folder: string;
  /** Its `package.json` version. */
  readonly version: string;
}

export type ReduceOutcome =
  | { readonly kind: 'reduced'; readonly reduced: ReducedInstall }
  | { readonly kind: 'fallback'; readonly reason: string }
  | { readonly kind: 'err'; readonly message: string };

/** What `reduceInstall` cuts down. Pure: the caller reads the files and the host's folders. */
export interface ReduceInputs {
  readonly manager: ImagePackageManager;
  /** The pack folder relative to the install root (`''` at the root). */
  readonly packRel: string;
  /** The app's install files (`HostInstall.files`). */
  readonly files: readonly string[];
  readonly lockfile: { readonly name: string; readonly text: string };
  readonly rootManifest: Manifest;
  readonly packManifest: Manifest;
  /** `pnpm-workspace.yaml`, when the app has one. */
  readonly workspaceText?: string;
  /** What the pack loads. */
  readonly roots: readonly HostPackage[];
  /** The build steps' tools. */
  readonly tools: readonly HostPackage[];
  /**
   * yarn 1, whose lockfile has no peer dependencies: each installed
   * package's peers (`name@version`), as the host resolves them.
   */
  readonly peers?: Readonly<Record<string, readonly HostPackage[]>>;
}

type Manifest = Readonly<Record<string, unknown>>;
type DepField = 'dependencies' | 'optionalDependencies' | 'devDependencies';

/** A root's place in the cut-down manifest: its field and specifier, and the lockfile entry it installs. */
interface RootEntry {
  readonly name: string;
  readonly field: DepField;
  readonly specifier: string;
  /** The lockfile's id for it: a pnpm snapshot key, an npm path, a yarn 1 entry. */
  readonly id: string;
  /** pnpm: the importer's `version` (the snapshot key's version part). */
  readonly ref?: string;
}

const PROD_FIELDS = ['dependencies', 'optionalDependencies'] as const;

/** The command that brings node_modules back in line with the lockfile. */
export function reinstallCommand(manager: ImagePackageManager): string {
  return manager === 'pnpm' ? 'pnpm install' : manager === 'npm' ? 'npm ci' : 'yarn install';
}

/** Cut the app's install down to the roots and what they depend on. */
export function reduceInstall(inputs: ReduceInputs): ReduceOutcome {
  const devOnly = inputs.roots.find(
    (root) =>
      directDependency(inputs, root.name, false) === undefined &&
      directDependency(inputs, root.name, true) !== undefined,
  );
  if (devOnly !== undefined) {
    const manifest = inputs.packRel === '' ? 'package.json' : `${inputs.packRel}/package.json`;
    return {
      kind: 'err',
      message: `The pack loads ${devOnly.name}, which ${manifest} lists only in devDependencies. The image keeps production dependencies only, so it wouldn't load there: move it to dependencies.`,
    };
  }
  const outside = [...inputs.roots, ...inputs.tools].find((p) => p.folder.startsWith('..'));
  if (outside !== undefined) {
    return fallback(`${outside.name} is installed outside the project (${outside.folder})`);
  }
  switch (inputs.manager) {
    case 'pnpm':
      return reducePnpm(inputs);
    case 'npm':
      return reduceNpm(inputs);
    case 'yarn':
      return reduceYarnClassic(inputs);
  }
}

// ---------------------------------------------------------------------
// pnpm
// ---------------------------------------------------------------------

interface PnpmLock {
  readonly lockfileVersion?: unknown;
  readonly importers?: Readonly<Record<string, PnpmImporter>>;
  readonly packages?: Readonly<Record<string, unknown>>;
  readonly snapshots?: Readonly<Record<string, PnpmSnapshot | null>>;
}

type PnpmImporter = Partial<
  Record<DepField, Readonly<Record<string, { specifier: string; version: string }>>>
>;

interface PnpmSnapshot {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

function reducePnpm(inputs: ReduceInputs): ReduceOutcome {
  const lockName = inputs.lockfile.name;
  const parts = splitPnpmLockfile(inputs.lockfile.text);
  if (parts === undefined)
    return fallback(`${lockName} has more YAML documents than kindgi build knows`);
  const doc = parseDocument(parts.project);
  if (doc.errors.length > 0) return fallback(`${lockName} doesn't parse as YAML`);
  const lock = (doc.toJS() ?? {}) as PnpmLock;
  if (lock.lockfileVersion !== '9.0') {
    return fallback(
      `${lockName} is lockfileVersion ${JSON.stringify(lock.lockfileVersion)}, and kindgi build cuts down only '9.0'`,
    );
  }
  const importers = lock.importers ?? {};
  const snapshots = lock.snapshots ?? {};
  const packages = lock.packages ?? {};
  const importerKeys = inputs.packRel === '' ? ['.'] : [inputs.packRel, '.'];

  const roots: RootEntry[] = [];
  for (const host of [...inputs.roots, ...inputs.tools]) {
    const tool = !inputs.roots.includes(host);
    const entry = pnpmRoot(host, importerKeys, importers, snapshots, tool);
    if (entry.kind === 'stale') return stale(inputs, host, undefined);
    if (entry.kind === 'stop') return entry.outcome;
    if (pnpmVersion(entry.root.id) !== host.version)
      return stale(inputs, host, pnpmVersion(entry.root.id));
    if (!roots.some((r) => r.name === entry.root.name)) roots.push(entry.root);
  }

  // The closure: each snapshot's dependencies and optional dependencies, peers included.
  const kept = new Set<string>();
  const todo = roots.map((r) => r.id);
  for (let key = todo.pop(); key !== undefined; key = todo.pop()) {
    if (kept.has(key)) continue;
    const snapshot = snapshots[key];
    if (snapshot === undefined || !Object.hasOwn(packages, withoutSuffix(key))) {
      return fallback(`${lockName} has no entry for ${key}`);
    }
    kept.add(key);
    for (const [name, ref] of [
      ...Object.entries(snapshot?.dependencies ?? {}),
      ...Object.entries(snapshot?.optionalDependencies ?? {}),
    ]) {
      if (isLocalRef(ref)) return localFallback(name, ref);
      todo.push(pnpmKey(name, ref));
    }
  }
  const keptPackages = new Set([...kept].map(withoutSuffix));
  const patchKept = (selector: string): boolean =>
    [...keptPackages].some((key) => patchApplies(selector, key));

  const importer: Record<string, Record<string, { specifier: string; version: string }>> = {};
  for (const root of [...roots].sort((a, b) => compare(a.name, b.name))) {
    const field = importer[root.field] ?? {};
    importer[root.field] = field;
    field[root.name] = {
      specifier: root.specifier,
      version: root.ref ?? '',
    };
  }
  doc.set('importers', doc.createNode({ '.': importer }));
  keepItems(doc, 'packages', (key) => keptPackages.has(key));
  keepItems(doc, 'snapshots', (key) => kept.has(key));
  keepItems(doc, 'patchedDependencies', patchKept);
  const lockText = `${parts.env ?? ''}${yamlText(doc)}`;

  const written: Record<string, string> = {
    'package.json': manifestText(inputs, roots, (pnpmField) => trimPatches(pnpmField, patchKept)),
    [lockName]: lockText,
  };
  const copied = new Set<string>();
  const workspace =
    inputs.workspaceText === undefined ? undefined : parseDocument(inputs.workspaceText);
  if (workspace !== undefined) {
    workspace.delete('packages');
    for (const path of patchPaths(workspace.toJS()?.patchedDependencies, patchKept))
      copied.add(path);
    keepItems(workspace, 'patchedDependencies', patchKept);
    if (isMap(workspace.contents) && workspace.contents.items.length > 0) {
      // The image installs one project; pnpm 9 refuses a workspace file without packages.
      workspace.set('packages', workspace.createNode(['.']));
      const items = workspace.contents.items;
      const added = items.pop();
      if (added !== undefined) items.unshift(added);
      written['pnpm-workspace.yaml'] = yamlText(workspace);
    }
  }
  const pnpmField = objectOf(inputs.rootManifest.pnpm);
  for (const path of patchPaths(pnpmField.patchedDependencies, patchKept)) copied.add(path);
  if (inputs.files.includes('.pnpmfile.cjs')) copied.add('.pnpmfile.cjs');
  const names = new Set([...keptPackages].map(pnpmName));
  return reduced(inputs, written, copied, names, kept.size, Object.keys(snapshots).length);
}

type RootLookup =
  | { readonly kind: 'ok'; readonly root: RootEntry }
  | { readonly kind: 'stale' }
  | { readonly kind: 'stop'; readonly outcome: ReduceOutcome };

/**
 * A root's snapshot: the pack's importer lists it (or the root's, for a
 * pack in a workspace member: Node reaches /app/node_modules from there),
 * or, when neither does (a hoisted package), the installed folder names it.
 */
function pnpmRoot(
  host: HostPackage,
  importerKeys: readonly string[],
  importers: Readonly<Record<string, PnpmImporter>>,
  snapshots: Readonly<Record<string, unknown>>,
  tool: boolean,
): RootLookup {
  for (const key of importerKeys) {
    const importer = importers[key] ?? {};
    const fields: readonly DepField[] = tool ? [...PROD_FIELDS, 'devDependencies'] : PROD_FIELDS;
    for (const field of fields) {
      const dep = importer[field]?.[host.name];
      if (dep === undefined) continue;
      if (isLocalRef(dep.version))
        return { kind: 'stop', outcome: localFallback(host.name, dep.version) };
      return {
        kind: 'ok',
        root: {
          name: host.name,
          field,
          specifier: dep.specifier,
          id: pnpmKey(host.name, dep.version),
          ref: dep.version,
        },
      };
    }
  }
  const folder = /(?:^|\/)node_modules\/\.pnpm\/([^/]+)\/node_modules\//.exec(host.folder)?.[1];
  const candidates = Object.keys(snapshots).filter(
    (key) => pnpmName(key) === host.name && pnpmVersion(key) === host.version,
  );
  const named =
    folder === undefined ? [] : candidates.filter((key) => pnpmFolderName(key) === folder);
  const key = named.length === 1 ? named[0] : candidates.length === 1 ? candidates[0] : undefined;
  if (key === undefined) {
    return candidates.length === 0
      ? { kind: 'stale' }
      : {
          kind: 'stop',
          outcome: fallback(
            `${host.name} ${host.version} is in the lockfile more than once, and its folder doesn't say which`,
          ),
        };
  }
  const ref = key.slice(host.name.length + 1);
  return {
    kind: 'ok',
    root: { name: host.name, field: 'dependencies', specifier: withoutSuffix(ref), id: key, ref },
  };
}

/** pnpm 11 and later can write an env document before the project's: kept as is. */
function splitPnpmLockfile(
  text: string,
): { readonly env?: string; readonly project: string } | undefined {
  const starts = [...text.matchAll(/^---$/gm)].map((m) => m.index);
  if (starts.length === 0 || (starts.length === 1 && starts[0] === 0)) return { project: text };
  if (starts.length === 2 && starts[0] === 0) {
    const second = starts[1] as number;
    return { env: text.slice(0, second), project: text.slice(second) };
  }
  return undefined;
}

/** A dependency's snapshot key: `name@version`, or the version itself when it's an alias (`string-width@4.2.3`). */
function pnpmKey(name: string, ref: string): string {
  return !/^[a-z+]+:/.test(ref) && withoutSuffix(ref).indexOf('@', 1) > 0 ? ref : `${name}@${ref}`;
}

function pnpmName(key: string): string {
  return key.slice(0, key.indexOf('@', 1));
}

/** The version part of a snapshot key, without its peer and patch suffixes. */
function pnpmVersion(key: string): string {
  return withoutSuffix(key).slice(key.indexOf('@', 1) + 1);
}

/** `react-dom@18.3.1(react@18.3.1)` → `react-dom@18.3.1`. */
function withoutSuffix(key: string): string {
  const paren = key.indexOf('(');
  return paren === -1 ? key : key.slice(0, paren);
}

/** pnpm's virtual-store folder for a snapshot key, when it isn't shortened with a hash. */
function pnpmFolderName(key: string): string {
  let name = key.replace(/[\\/:*?"<>|]/g, '+');
  if (name.includes('(')) name = name.replace(/\)$/, '').replace(/\)\(|\(|\)/g, '_');
  return name;
}

/** Whether a patch selector (`name`, `name@1.2.3`, `name@^1`) applies to a package key (`name@1.2.3`). */
function patchApplies(selector: string, packageKey: string): boolean {
  const at = selector.indexOf('@', 1);
  const name = at === -1 ? selector : selector.slice(0, at);
  if (pnpmName(packageKey) !== name) return false;
  if (at === -1) return true;
  const wanted = selector.slice(at + 1);
  const version = pnpmVersion(packageKey);
  return wanted === version || (validRange(wanted) !== null && satisfies(version, wanted));
}

function patchPaths(patches: unknown, keep: (selector: string) => boolean): string[] {
  return Object.entries(objectOf(patches))
    .filter(([selector]) => keep(selector))
    .map(([, value]) => (typeof value === 'string' ? value : objectOf(value).path))
    .filter((path): path is string => typeof path === 'string');
}

function trimPatches(pnpmField: Manifest, keep: (selector: string) => boolean): Manifest {
  const patches = pnpmField.patchedDependencies;
  if (patches === undefined) return pnpmField;
  const kept = Object.fromEntries(
    Object.entries(objectOf(patches)).filter(([selector]) => keep(selector)),
  );
  const { patchedDependencies: _, ...rest } = pnpmField;
  return Object.keys(kept).length > 0 ? { ...rest, patchedDependencies: kept } : rest;
}

// ---------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------

interface NpmEntry {
  readonly version?: string;
  readonly resolved?: string;
  readonly link?: boolean;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly [field: string]: unknown;
}

function reduceNpm(inputs: ReduceInputs): ReduceOutcome {
  const lockName = inputs.lockfile.name;
  let lock: {
    lockfileVersion?: unknown;
    packages?: Record<string, NpmEntry>;
    [field: string]: unknown;
  };
  try {
    lock = JSON.parse(inputs.lockfile.text);
  } catch {
    return fallback(`${lockName} isn't JSON`);
  }
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) {
    return fallback(
      `${lockName} is lockfileVersion ${String(lock.lockfileVersion)}, and kindgi build cuts down only 2 and 3`,
    );
  }
  const entries = lock.packages ?? {};

  const roots: RootEntry[] = [];
  for (const host of [...inputs.roots, ...inputs.tools]) {
    const entry = entries[host.folder];
    if (entry?.link === true || isLocalRef(entry?.resolved ?? '')) {
      return localFallback(host.name, entry?.resolved ?? 'a link');
    }
    if (entry === undefined || entry.version !== host.version)
      return stale(inputs, host, entry?.version);
    const tool = !inputs.roots.includes(host);
    const direct = directDependency(inputs, host.name, tool);
    if (!roots.some((r) => r.name === host.name)) {
      roots.push({
        name: host.name,
        field: direct?.field ?? 'dependencies',
        specifier: direct?.specifier ?? entry.version,
        id: host.folder,
      });
    }
  }

  // The closure, resolved as Node does: each package's own node_modules, then its parents'.
  const reach = (from: readonly RootEntry[]): Set<string> | ReduceOutcome => {
    const seen = new Set<string>();
    const todo = from.map((r) => r.id);
    for (let path = todo.pop(); path !== undefined; path = todo.pop()) {
      if (seen.has(path)) continue;
      const entry = entries[path];
      if (entry === undefined) return fallback(`${lockName} has no entry for ${path}`);
      if (entry.link === true || isLocalRef(entry.resolved ?? '')) {
        return localFallback(packageNameOf(path), entry.resolved ?? 'a link');
      }
      seen.add(path);
      const wanted = [
        ...Object.keys(entry.dependencies ?? {}).map((name) => [name, true] as const),
        ...Object.keys(entry.optionalDependencies ?? {}).map((name) => [name, false] as const),
        ...Object.keys(entry.peerDependencies ?? {}).map((name) => [name, false] as const),
      ];
      for (const [name, required] of wanted) {
        const found = npmResolve(entries, path, name);
        if (found !== undefined) todo.push(found);
        else if (required) return fallback(`${lockName} has no ${name} for ${path}`);
      }
    }
    return seen;
  };
  const prod = reach(roots.filter((r) => r.field !== 'devDependencies'));
  if (!(prod instanceof Set)) return prod;
  const all = reach(roots);
  if (!(all instanceof Set)) return all;

  // A pack in a workspace member: its own nested packages move to the root's node_modules.
  const memberPrefix = inputs.packRel === '' ? undefined : `${inputs.packRel}/`;
  const moved = new Map<string, string>();
  for (const path of all) {
    const to =
      memberPrefix !== undefined && path.startsWith(memberPrefix)
        ? path.slice(memberPrefix.length)
        : path;
    const already = [...moved.entries()].find(([, target]) => target === to);
    if (already !== undefined) {
      return fallback(
        `${packageNameOf(to)} is installed twice for the pack (${already[0]} and ${path})`,
      );
    }
    moved.set(path, to);
  }

  const root = entries[''] ?? {};
  const packagesOut: Record<string, unknown> = {
    '': {
      ...(typeof root.name === 'string' && { name: root.name }),
      ...(typeof root.version === 'string' && { version: root.version }),
      ...dependencyFields(roots),
    },
  };
  for (const [from, to] of [...moved.entries()].sort(([, a], [, b]) => compare(a, b))) {
    const { dev: _dev, devOptional: _devOptional, ...entry } = entries[from] as NpmEntry;
    packagesOut[to] = prod.has(from) ? entry : { ...entry, dev: true };
  }
  // lockfileVersion 2 also has the npm 6 tree (`dependencies`): the cut-down one has `packages` only.
  const { packages: _, dependencies: _legacy, ...header } = lock;
  const written = {
    'package.json': manifestText(inputs, roots),
    [lockName]: `${JSON.stringify({ ...header, packages: packagesOut }, null, 2)}\n`,
  };
  const total = Object.entries(entries).filter(
    ([path, e]) => path.includes('node_modules/') && e.link !== true,
  ).length;
  const names = new Set([...moved.values()].map(packageNameOf));
  return reduced(inputs, written, new Set(), names, all.size, total);
}

/** Where Node finds `name` from the package at `from`, by the lockfile's paths. */
function npmResolve(
  entries: Readonly<Record<string, NpmEntry>>,
  from: string,
  name: string,
): string | undefined {
  for (let dir = from; ; dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '') {
    const path = dir === '' ? `node_modules/${name}` : `${dir}/node_modules/${name}`;
    if (entries[path] !== undefined) return path;
    if (dir === '') return undefined;
  }
}

/** `node_modules/a/node_modules/@scope/b` → `@scope/b`. */
function packageNameOf(path: string): string {
  return path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

// ---------------------------------------------------------------------
// yarn 1
// ---------------------------------------------------------------------

interface YarnBlock {
  readonly text: string;
  /** `name@range`, as the block's first line lists them. */
  readonly keys: readonly string[];
  readonly version: string;
  readonly resolved: string;
  readonly dependencies: readonly (readonly [string, string, boolean])[];
}

function reduceYarnClassic(inputs: ReduceInputs): ReduceOutcome {
  const lockName = inputs.lockfile.name;
  const text = inputs.lockfile.text;
  if (!/^# yarn lockfile v1$/m.test(text))
    return fallback(`${lockName} isn't a yarn 1 lockfile kindgi build knows`);
  const blocks = parseYarnLockfile(text);
  const byKey = new Map<string, YarnBlock>();
  for (const block of blocks) for (const key of block.keys) byKey.set(key, block);

  const roots: RootEntry[] = [];
  for (const host of [...inputs.roots, ...inputs.tools]) {
    const block = blocks.find(
      (b) => b.version === host.version && b.keys.some((k) => yarnName(k) === host.name),
    );
    if (block === undefined) return stale(inputs, host, undefined);
    if (
      isLocalRef(block.resolved) ||
      block.keys.some((k) => isLocalRef(k.slice(yarnName(k).length + 1)))
    ) {
      return localFallback(host.name, block.resolved);
    }
    const tool = !inputs.roots.includes(host);
    const direct = directDependency(inputs, host.name, tool);
    const specifier =
      direct?.specifier ??
      (block.keys.find((k) => yarnName(k) === host.name) ?? '').slice(host.name.length + 1);
    if (!block.keys.includes(`${host.name}@${specifier}`)) {
      return {
        kind: 'err',
        message: `${direct?.manifest ?? 'package.json'} lists ${host.name}@${specifier}, and ${lockName} has no entry for it: the lockfile is out of date with it. Run ${reinstallCommand(inputs.manager)}, then kindgi build again.`,
      };
    }
    if (!roots.some((r) => r.name === host.name)) {
      roots.push({
        name: host.name,
        field: direct?.field ?? 'dependencies',
        specifier,
        id: `${host.name}@${specifier}`,
      });
    }
  }

  // What the app's production install has: the projects' production dependencies and theirs.
  const production = new Set<YarnBlock>();
  const manifests =
    inputs.packRel === '' ? [inputs.rootManifest] : [inputs.packManifest, inputs.rootManifest];
  const reach = manifests.flatMap((m) =>
    PROD_FIELDS.flatMap((field) =>
      Object.entries(objectOf(m[field])).map(([name, range]) => `${name}@${String(range)}`),
    ),
  );
  for (let key = reach.pop(); key !== undefined; key = reach.pop()) {
    const block = byKey.get(key);
    if (block === undefined || production.has(block)) continue;
    production.add(block);
    reach.push(...block.dependencies.map(([name, range]) => `${name}@${range}`));
  }

  const kept = new Set<YarnBlock>();
  const todo = roots.map((r) => r.id);
  for (let key = todo.pop(); key !== undefined; key = todo.pop()) {
    const block = byKey.get(key);
    if (block === undefined) return fallback(`${lockName} has no entry for ${key}`);
    if (kept.has(block)) continue;
    if (isLocalRef(block.resolved)) return localFallback(yarnName(key), block.resolved);
    kept.add(block);
    for (const [name, range, required] of block.dependencies) {
      const dep = `${name}@${range}`;
      if (byKey.has(dep) || required) todo.push(dep);
    }
    // yarn 1 installs only what the manifest reaches, peers not included: a
    // peer the app's production install has becomes a dependency of its own.
    for (const peer of inputs.peers?.[`${yarnName(key)}@${block.version}`] ?? []) {
      const target = blocks.find(
        (b) => b.version === peer.version && b.keys.some((k) => yarnName(k) === peer.name),
      );
      if (target === undefined) return stale(inputs, peer, undefined);
      if (!production.has(target) || roots.some((r) => r.name === peer.name)) continue;
      const peerKey = target.keys.find((k) => yarnName(k) === peer.name) ?? '';
      roots.push({
        name: peer.name,
        field: 'dependencies',
        specifier: peerKey.slice(peer.name.length + 1),
        id: peerKey,
      });
      todo.push(peerKey);
    }
  }

  const header = text.split('\n').filter((line) => line.startsWith('#'));
  const body = blocks.filter((b) => kept.has(b)).map((b) => b.text);
  const written = {
    'package.json': manifestText(inputs, roots),
    [lockName]: `${header.join('\n')}\n\n\n${body.join('\n\n')}\n`,
  };
  const names = new Set([...kept].flatMap((block) => block.keys.map(yarnName)));
  return reduced(inputs, written, new Set(), names, kept.size, blocks.length);
}

/** The blocks of a yarn 1 lockfile: `"a@^1", a@~1:`, its fields, its dependencies. */
function parseYarnLockfile(text: string): YarnBlock[] {
  const blocks: YarnBlock[] = [];
  for (const chunk of text.split(/\n\s*\n/)) {
    const lines = chunk.split('\n').filter((line) => line !== '' && !line.startsWith('#'));
    const first = lines[0];
    if (first === undefined || first.startsWith(' ')) continue;
    const keys = first
      .replace(/:$/, '')
      .split(/,\s*/)
      .map((key) => unquote(key.trim()));
    let version = '';
    let resolved = '';
    let section: 'dependencies' | 'optionalDependencies' | undefined;
    const dependencies: [string, string, boolean][] = [];
    for (const line of lines.slice(1)) {
      if (line.startsWith('    ') && section !== undefined) {
        const match = /^\s+("[^"]+"|\S+)\s+(.+)$/.exec(line);
        if (match !== null) {
          dependencies.push([
            unquote(match[1] ?? ''),
            unquote(match[2] ?? ''),
            section === 'dependencies',
          ]);
        }
        continue;
      }
      section = undefined;
      const field = /^ {2}(\S+)\s*(.*)$/.exec(line);
      if (field === null) continue;
      if (field[1] === 'version') version = unquote(field[2] ?? '');
      else if (field[1] === 'resolved') resolved = unquote(field[2] ?? '');
      else if (field[1] === 'dependencies:' || field[1] === 'optionalDependencies:') {
        section = field[1].slice(0, -1) as 'dependencies' | 'optionalDependencies';
      }
    }
    blocks.push({ text: lines.join('\n'), keys, version, resolved, dependencies });
  }
  return blocks;
}

function yarnName(key: string): string {
  return key.slice(0, key.indexOf('@', 1));
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

// ---------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------

/** How the pack's project (or, for a pack in a member, the root's) lists `name`: a production field, or a dev one for a tool. */
function directDependency(
  inputs: ReduceInputs,
  name: string,
  tool: boolean,
): { readonly field: DepField; readonly specifier: string; readonly manifest: string } | undefined {
  const manifests: readonly (readonly [string, Manifest])[] =
    inputs.packRel === ''
      ? [['package.json', inputs.rootManifest]]
      : [
          [`${inputs.packRel}/package.json`, inputs.packManifest],
          ['package.json', inputs.rootManifest],
        ];
  const fields: readonly DepField[] = tool ? [...PROD_FIELDS, 'devDependencies'] : PROD_FIELDS;
  for (const [path, manifest] of manifests) {
    for (const field of fields) {
      const specifier = objectOf(manifest[field])[name];
      if (typeof specifier === 'string') return { field, specifier, manifest: path };
    }
  }
  return undefined;
}

/** The cut-down `package.json`: the roots, and the root manifest's settings the install reads. */
function manifestText(
  inputs: ReduceInputs,
  roots: readonly RootEntry[],
  pnpmField: (field: Manifest) => Manifest = (field) => field,
): string {
  const root = inputs.rootManifest;
  const settings =
    inputs.manager === 'pnpm' ? 'pnpm' : inputs.manager === 'npm' ? 'overrides' : 'resolutions';
  const setting = root[settings];
  const manifest = {
    ...(typeof root.name === 'string' && { name: root.name }),
    ...(typeof root.version === 'string' && { version: root.version }),
    private: true,
    ...(typeof root.packageManager === 'string' && { packageManager: root.packageManager }),
    ...(setting !== undefined && {
      [settings]: settings === 'pnpm' ? pnpmField(objectOf(setting)) : setting,
    }),
    ...dependencyFields(roots),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function dependencyFields(roots: readonly RootEntry[]): Record<string, Record<string, string>> {
  const fields: Record<string, Record<string, string>> = {};
  for (const root of [...roots].sort((a, b) => compare(a.name, b.name))) {
    const field = fields[root.field] ?? {};
    fields[root.field] = field;
    field[root.name] = root.specifier;
  }
  return fields;
}

function reduced(
  inputs: ReduceInputs,
  written: Record<string, string>,
  copied: Set<string>,
  names: ReadonlySet<string>,
  kept: number,
  total: number,
): ReduceOutcome {
  if (inputs.packRel !== '') copied.add(`${inputs.packRel}/package.json`);
  const own = objectOf(
    (inputs.packRel === '' ? inputs.rootManifest : inputs.packManifest).dependencies,
  );
  const leftOut = Object.keys(own)
    .filter((name) => !names.has(name))
    .sort(compare);
  return {
    kind: 'reduced',
    reduced: { written, copied: [...copied].sort(), kept, total, leftOut },
  };
}

/** A package the host has at a version the lockfile doesn't pin for it. */
function stale(inputs: ReduceInputs, host: HostPackage, locked: string | undefined): ReduceOutcome {
  const pinned =
    locked === undefined
      ? `${inputs.lockfile.name} has no ${host.name} ${host.version}`
      : `${inputs.lockfile.name} pins ${locked}`;
  return {
    kind: 'err',
    message: `${host.name} is installed at ${host.folder} (${host.version}), but ${pinned}: node_modules is out of date with the lockfile, so the build would use code the lockfile doesn't pin. Run ${reinstallCommand(inputs.manager)}, then kindgi build again.`,
  };
}

function localFallback(name: string, ref: string): ReduceOutcome {
  return fallback(`${name} is a local package (${ref})`);
}

function fallback(reason: string): ReduceOutcome {
  return { kind: 'fallback', reason };
}

function isLocalRef(ref: string): boolean {
  return /^(link|file|workspace|portal):/.test(ref);
}

/** Keep a top-level map's entries whose key passes; drop the map when none does. */
function keepItems(
  doc: ReturnType<typeof parseDocument>,
  key: string,
  keep: (entryKey: string) => boolean,
): void {
  const node = doc.get(key, true);
  if (!isMap(node)) return;
  node.items = node.items.filter((pair) =>
    keep(String(isScalar(pair.key) ? pair.key.value : pair.key)),
  );
  if (node.items.length === 0) doc.delete(key);
}

/** A YAML document as text, its first line never blank (the blank before a dropped `packages:` stays otherwise). */
function yamlText(doc: ReturnType<typeof parseDocument>): string {
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false }).replace(/^\n+/, '');
}

function objectOf(value: unknown): Manifest {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Manifest)
    : {};
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------

/** Where Node finds `name` from `fromDir`, up to the install root: its real folder and version. */
export async function findHostPackage(
  root: string,
  fromDir: string,
  name: string,
): Promise<HostPackage | undefined> {
  const top = resolve(root);
  for (let dir = resolve(fromDir); ; dir = dirname(dir)) {
    const folder = join(dir, 'node_modules', name);
    const manifest = await readJson(join(folder, 'package.json'));
    if (manifest !== undefined) {
      const real = relative(await realpath(top), await realpath(folder))
        .split(sep)
        .join('/');
      return {
        name,
        folder: real,
        version: typeof manifest.version === 'string' ? manifest.version : '',
      };
    }
    if (dir === top || dirname(dir) === dir) return undefined;
  }
}

/** The installed packages, for the pack at `packDir`: what the cut-down install starts from. */
export interface LoadedInstallOptions {
  readonly install: HostInstall;
  readonly packDir: string;
  /** What the bundles import by name (`externals.json`'s packages). */
  readonly externals: readonly string[];
  readonly image: Pick<ResolvedImage, 'keep' | 'keepIfInstalled' | 'steps'>;
}

export type LoadedInstallOutcome =
  | { readonly kind: 'reduced'; readonly install: HostInstall }
  | { readonly kind: 'fallback'; readonly reason: string }
  | { readonly kind: 'err'; readonly message: string };

/**
 * With `image.dependencies: 'loaded'`: the app's install, cut down to what
 * the pack loads, checked against the app's lockfile; or why the image
 * takes the full install and trims it.
 */
export async function loadedInstall(opts: LoadedInstallOptions): Promise<LoadedInstallOutcome> {
  const { install, packDir } = opts;
  if (install.manager === 'yarn' && install.yarnBerry) {
    return {
      kind: 'fallback',
      reason: "yarn berry's lockfile can't be cut down by hand and still install immutably",
    };
  }
  const lockName = install.files.find((file) => LOCKFILE_NAMES.includes(file));
  if (lockName === undefined)
    return { kind: 'fallback', reason: 'the install has no lockfile kindgi build can cut down' };
  const rootManifest = await readJson(join(install.root, 'package.json'));
  if (rootManifest === undefined)
    return { kind: 'err', message: `${join(install.root, 'package.json')} isn't JSON.` };
  const packManifest = (await readJson(join(packDir, 'package.json'))) ?? {};

  const roots: HostPackage[] = [];
  const required = [
    ...new Set([...opts.externals, ...opts.image.keep.filter(isPackageName)]),
  ].sort();
  for (const name of required) {
    const host = await findHostPackage(install.root, packDir, name);
    if (host === undefined) {
      return {
        kind: 'err',
        message: `The pack loads ${name}, but Node doesn't find it from ${packDir}, where the image loads it from: add it to the dependencies of ${join(packDir, 'package.json')}, run ${reinstallCommand(install.manager)}, then kindgi build again.`,
      };
    }
    roots.push(host);
  }
  for (const name of opts.image.keepIfInstalled.filter(isPackageName)) {
    const host = await findHostPackage(install.root, packDir, name);
    if (host !== undefined && !roots.some((r) => r.name === name)) roots.push(host);
  }

  const tools: HostPackage[] = [];
  for (const bin of [...new Set(opts.image.steps.map((step) => step.bin))]) {
    const tool = await stepTool(install, packDir, rootManifest, packManifest, bin);
    if (tool === undefined) {
      return { kind: 'fallback', reason: `no dependency of the pack has the build step's ${bin}` };
    }
    if (![...roots, ...tools].some((p) => p.name === tool.name)) tools.push(tool);
  }

  const peers = install.manager === 'yarn' ? await installedPeers(install) : undefined;
  const lockText = await readFile(join(install.root, lockName), 'utf8');
  const workspaceText = install.files.includes('pnpm-workspace.yaml')
    ? await readFile(join(install.root, 'pnpm-workspace.yaml'), 'utf8')
    : undefined;
  const outcome = reduceInstall({
    manager: install.manager,
    packRel: install.packRel,
    files: install.files,
    lockfile: { name: lockName, text: lockText },
    rootManifest,
    packManifest,
    ...(workspaceText !== undefined && { workspaceText }),
    roots,
    tools,
    ...(peers !== undefined && { peers }),
  });
  if (outcome.kind !== 'reduced') return outcome;
  const reducedLock = outcome.reduced.written[lockName] ?? '';
  const check = checkReducedLockfile({
    manager: install.manager,
    packRel: install.packRel,
    lockfile: lockText,
    reduced: reducedLock,
    manifest: outcome.reduced.written['package.json'] ?? '',
    rootManifest,
    packManifest,
  });
  if (check.kind === 'refused') {
    return {
      kind: 'err',
      message: `kindgi build cut ${lockName} down to what the pack loads, and the result doesn't match the app's lockfile: ${check.message}. Build with image.dependencies: 'all' meanwhile, and report this.`,
    };
  }
  const files = [
    ...new Set([...Object.keys(outcome.reduced.written), ...outcome.reduced.copied]),
  ].sort();
  return {
    kind: 'reduced',
    install: {
      ...install,
      workspace: false,
      files,
      projectManifests: install.projectManifests.filter((file) =>
        outcome.reduced.copied.includes(file),
      ),
      reduced: outcome.reduced,
    },
  };
}

const LOCKFILE_NAMES: readonly string[] = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
];

/** A keep that's a package, not a folder a step writes (`.prisma/client`). */
function isPackageName(name: string): boolean {
  return !name.startsWith('.');
}

/** The pack's dependency whose `bin` has `bin`: the tool a build step runs. */
async function stepTool(
  install: HostInstall,
  packDir: string,
  rootManifest: Manifest,
  packManifest: Manifest,
  bin: string,
): Promise<HostPackage | undefined> {
  const manifests = install.packRel === '' ? [rootManifest] : [packManifest, rootManifest];
  const names = [
    ...new Set(
      manifests.flatMap((m) =>
        (['dependencies', 'optionalDependencies', 'devDependencies'] as const).flatMap((f) =>
          Object.keys(objectOf(m[f])),
        ),
      ),
    ),
  ].sort();
  for (const name of names) {
    const host = await findHostPackage(install.root, packDir, name);
    if (host === undefined) continue;
    const manifest = await readJson(join(install.root, host.folder, 'package.json'));
    const bins = manifest?.bin;
    const has =
      typeof bins === 'string'
        ? (name.split('/').pop() ?? name) === bin
        : Object.hasOwn(objectOf(bins), bin);
    if (has) return host;
  }
  return undefined;
}

/**
 * Every installed package's peer dependencies, resolved where Node finds
 * them from the package's folder, by `name@version`: what yarn 1's
 * lockfile leaves out. Links (workspace members) aren't followed.
 */
async function installedPeers(install: HostInstall): Promise<Record<string, HostPackage[]>> {
  const peers: Record<string, HostPackage[]> = {};
  const projects = install.projectManifests.map((manifest) =>
    dirname(join(install.root, manifest)),
  );
  const todo = projects.map((dir) => join(dir, 'node_modules'));
  for (let dir = todo.pop(); dir !== undefined; dir = todo.pop()) {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const folder = join(dir, entry.name);
      if (entry.name.startsWith('@')) {
        todo.push(folder);
        continue;
      }
      todo.push(join(folder, 'node_modules'));
      const manifest = await readJson(join(folder, 'package.json'));
      const names = Object.keys(objectOf(manifest?.peerDependencies));
      if (manifest === undefined || names.length === 0 || typeof manifest.version !== 'string')
        continue;
      const found: HostPackage[] = [];
      for (const name of names) {
        const host = await findHostPackage(install.root, folder, name);
        if (host !== undefined) found.push(host);
      }
      peers[`${String(manifest.name)}@${manifest.version}`] = found;
    }
  }
  return peers;
}

async function readJson(path: string): Promise<Manifest | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Manifest)
      : undefined;
  } catch {
    return undefined;
  }
}
