// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A pack image that carries only what the pack loads
 * (`image.dependencies: 'loaded'`): the package closure of the
 * packages its bundles import by name, plus what `image.keep` and the
 * build extensions keep.
 *
 * Every package is resolved the way Node resolves it at run time: an
 * external from the bundles' folder upward, a package's dependency from
 * that package's real folder upward. A kept package's `dependencies`,
 * `optionalDependencies` and `peerDependencies` that are installed are
 * kept too, recursively, and a package is kept whole (its own files; its
 * nested `node_modules` hold its dependencies, which are resolved like
 * any other). So it works on the layout the package manager made from
 * the lockfile: pnpm's links into `.pnpm`, npm's and Yarn's hoisting,
 * nested copies.
 *
 * The trimmed tree is the install root as it was, minus every
 * `node_modules` folder, plus the kept packages and the links Node
 * resolves through. What isn't a dependency (manifests, the lockfile, a
 * workspace package's sources) stays as it was.
 *
 * A pack image's closure stage runs it (`kindgi-closure-main`, bundled as
 * `dist/kindgi-closure.mjs`), with no network and no secrets; the image's
 * indexer then runs on the trimmed tree, so a package the bundles load
 * and the closure missed fails the build, never a run.
 */

import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  stat,
  symlink,
} from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';

export interface ClosureInputs {
  /** The install root (`/app`). */
  readonly root: string;
  /** The bundles' folder (`/app/<pack>/dist`): externals resolve from here, as Node resolves them. */
  readonly bundleDir: string;
  /** The packages the bundles import by name (`@scope/name`, `name`). */
  readonly externals: readonly string[];
  /**
   * More to keep: packages the bundles don't import by name (a plugin
   * named in a config string), or a generated folder such as
   * `.prisma/client`. Each resolves from the bundles' folder, else from
   * the folder of a package already kept.
   */
  readonly keep: readonly string[];
  /**
   * Kept when installed, skipped otherwise: a build extension's keeps,
   * which depend on how the app uses it (`.prisma/client` exists only for
   * Prisma's `prisma-client-js` generator).
   */
  readonly keepIfInstalled?: readonly string[];
}

/** A package the closure keeps, by its real folder. */
export interface KeptPackage {
  readonly name: string;
  /** Its real folder, absolute. */
  readonly dir: string;
  /** Why it's kept: `external`, `keep`, or `a dependency of <name>`. */
  readonly reason: string;
}

/** A link Node resolves through (pnpm's `node_modules/<name>` → `.pnpm/…`), as it is in the install. */
export interface ClosureLink {
  readonly path: string;
  /** What the link holds (`readlink`), relative or absolute as the package manager wrote it. */
  readonly target: string;
}

export interface MissingPackage {
  readonly name: string;
  readonly reason: 'external' | 'keep';
}

export interface Closure {
  /** Sorted by folder. */
  readonly packages: readonly KeptPackage[];
  /** Sorted by path. */
  readonly links: readonly ClosureLink[];
  /** Externals or keeps Node can't resolve: the build fails on these, naming each. */
  readonly missing: readonly MissingPackage[];
  /** `keepIfInstalled` names that aren't installed: skipped, and said. */
  readonly skipped: readonly string[];
}

interface Resolved {
  readonly dir: string;
  readonly links: readonly ClosureLink[];
}

/** The closure of `inputs`: what the trimmed tree keeps. */
export async function computeClosure(inputs: ClosureInputs): Promise<Closure> {
  const kept = new Map<string, KeptPackage>();
  const links = new Map<string, ClosureLink>();
  const missing: MissingPackage[] = [];
  const skipped: string[] = [];
  const queue: KeptPackage[] = [];
  const add = (resolved: Resolved, name: string, reason: string): void => {
    for (const link of resolved.links) links.set(link.path, link);
    if (kept.has(resolved.dir)) return;
    const pkg = { name, dir: resolved.dir, reason };
    kept.set(resolved.dir, pkg);
    queue.push(pkg);
  };

  for (const name of sortedUnique(inputs.externals)) {
    const resolved = await resolvePackage(name, inputs.bundleDir, inputs.root);
    if (resolved === undefined) missing.push({ name, reason: 'external' });
    else add(resolved, name, 'external');
  }
  await keepDependencies(queue, inputs.root, add);

  // A keep resolves from the bundles' folder, else beside a package kept
  // already (a generated `.prisma/client` sits next to `@prisma/client`).
  for (const name of sortedUnique(inputs.keep)) {
    const resolved = await resolveKeep(name, inputs, [...kept.keys()].sort());
    if (resolved === undefined) missing.push({ name, reason: 'keep' });
    else add(resolved, name, 'keep');
  }
  for (const name of sortedUnique(inputs.keepIfInstalled ?? [])) {
    const resolved = await resolveKeep(name, inputs, [...kept.keys()].sort());
    if (resolved !== undefined) add(resolved, name, 'keep');
    else skipped.push(name);
  }
  await keepDependencies(queue, inputs.root, add);

  return {
    packages: [...kept.values()].sort((a, b) => compare(a.dir, b.dir)),
    links: [...links.values()].sort((a, b) => compare(a.path, b.path)),
    missing,
    skipped,
  };
}

async function resolveKeep(
  name: string,
  inputs: ClosureInputs,
  keptDirs: readonly string[],
): Promise<Resolved | undefined> {
  const fromBundles = await resolvePackage(name, inputs.bundleDir, inputs.root);
  if (fromBundles !== undefined) return fromBundles;
  for (const dir of keptDirs) {
    const beside = await resolvePackage(name, dir, inputs.root);
    if (beside !== undefined) return beside;
  }
  return undefined;
}

/** Keep every installed dependency of the queued packages, recursively. */
async function keepDependencies(
  queue: KeptPackage[],
  root: string,
  add: (resolved: Resolved, name: string, reason: string) => void,
): Promise<void> {
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const dependency of await dependencyNames(next.dir)) {
      // Not installed: an optional dependency or peer this platform or
      // app skipped, or a dev dependency the image doesn't have. Node only
      // fails if something loads it, and the image's gates load them.
      const resolved = await resolvePackage(dependency, next.dir, root);
      if (resolved !== undefined) add(resolved, dependency, `a dependency of ${next.name}`);
    }
  }
}

/** The names a package may load from its own dependencies: declared, optional and peer. */
async function dependencyNames(dir: string): Promise<string[]> {
  const manifest = await readManifest(dir);
  if (manifest === undefined) return [];
  const names = new Set<string>();
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    const deps = manifest[field];
    if (deps !== null && typeof deps === 'object')
      for (const name of Object.keys(deps)) names.add(name);
  }
  return [...names].sort();
}

/**
 * `name` as Node resolves it from `fromDir`: the first `node_modules/<name>`
 * with a `package.json`, from `fromDir` upward, inside `root`; its real
 * folder, and the links on the way to it.
 */
export async function resolvePackage(
  name: string,
  fromDir: string,
  root: string,
): Promise<Resolved | undefined> {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    if (basename(dir) !== 'node_modules') {
      const nodeModules = join(dir, 'node_modules');
      const candidate = join(nodeModules, ...name.split('/'));
      if (inside(root, candidate) && (await isFile(join(candidate, 'package.json')))) {
        return { dir: await realpath(candidate), links: await linksOnTheWay(nodeModules, name) };
      }
    }
    if (dirname(dir) === dir || !inside(root, dir)) return undefined;
  }
}

/** The links among `node_modules/@scope` and `node_modules/@scope/name` (or `node_modules/name`). */
async function linksOnTheWay(nodeModules: string, name: string): Promise<ClosureLink[]> {
  const links: ClosureLink[] = [];
  let path = nodeModules;
  for (const part of name.split('/')) {
    path = join(path, part);
    if ((await lstat(path)).isSymbolicLink()) links.push({ path, target: await readlink(path) });
  }
  return links;
}

// ---------------------------------------------------------------------
// Writing the trimmed tree
// ---------------------------------------------------------------------

/**
 * Write the trimmed tree for `closure` to `out`: `root` without its
 * `node_modules` folders, each kept package's own files at its place
 * under `out`, and the links. Timestamps and links are copied as they
 * are, so the image layer stays reproducible.
 */
export async function writeClosure(closure: Closure, root: string, out: string): Promise<void> {
  await cp(root, out, {
    recursive: true,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    filter: (source) => !hasNodeModulesSegment(relative(root, source)),
  });
  for (const pkg of closure.packages) {
    await cp(pkg.dir, join(out, relative(root, pkg.dir)), {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      filter: (source) => !hasNodeModulesSegment(relative(pkg.dir, source)),
    });
  }
  for (const link of closure.links) {
    const path = join(out, relative(root, link.path));
    await mkdir(dirname(path), { recursive: true });
    await symlink(link.target, path);
  }
}

function hasNodeModulesSegment(path: string): boolean {
  return path.split(sep).includes('node_modules');
}

// ---------------------------------------------------------------------
// What the build prints
// ---------------------------------------------------------------------

export interface ClosureReport {
  readonly kept: number;
  readonly installed: number;
  readonly keptBytes: number;
  readonly installedBytes: number;
  /** The pack's own `dependencies` the closure dropped: where a reader spots a plugin loaded by name. */
  readonly droppedOwn: readonly string[];
}

/** How much the closure keeps of what's installed under `root`, and which of the pack's own dependencies it drops. */
export async function closureReport(
  closure: Closure,
  root: string,
  packDir: string,
): Promise<ClosureReport> {
  const installed = await installedPackages(root);
  const keptDirs = new Set(closure.packages.map((p) => p.dir));
  let keptBytes = 0;
  for (const dir of keptDirs) keptBytes += await packageBytes(dir);
  let installedBytes = 0;
  for (const dir of installed) installedBytes += await packageBytes(dir);
  const droppedOwn: string[] = [];
  for (const name of await ownDependencies(packDir)) {
    const resolved = await resolvePackage(name, packDir, root);
    if (resolved !== undefined && !keptDirs.has(resolved.dir)) droppedOwn.push(name);
  }
  return { kept: keptDirs.size, installed: installed.size, keptBytes, installedBytes, droppedOwn };
}

/** The report as the build prints it: one line, and a second when the pack's own dependencies were dropped. */
export function formatClosureReport(report: ClosureReport): string[] {
  const lines = [
    `kept ${count(report.kept)} of ${count(report.installed)} packages (${size(report.keptBytes)} of ${size(report.installedBytes)})`,
  ];
  if (report.droppedOwn.length > 0) {
    lines.push(
      `dropped ${report.droppedOwn.length} of the pack's own dependencies its tools don't import: ${report.droppedOwn.join(', ')}`,
    );
  }
  return lines;
}

async function ownDependencies(packDir: string): Promise<string[]> {
  const deps = (await readManifest(packDir))?.dependencies;
  return deps !== null && typeof deps === 'object' ? Object.keys(deps).sort() : [];
}

/** Every installed package's real folder under `root`'s `node_modules` folders, nested ones and pnpm's `.pnpm` included. */
async function installedPackages(root: string): Promise<Set<string>> {
  const found = new Set<string>();
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await entries(dir)) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name === 'node_modules') await scanNodeModules(path, found);
      else await visit(path);
    }
  };
  await visit(root);
  return found;
}

async function scanNodeModules(nodeModules: string, found: Set<string>): Promise<void> {
  for (const entry of await entries(nodeModules)) {
    const path = join(nodeModules, entry.name);
    if (entry.name === '.pnpm') {
      for (const id of await entries(path))
        await scanNodeModules(join(path, id.name, 'node_modules'), found);
    } else if (entry.name.startsWith('@')) {
      for (const scoped of await entries(path)) await addPackage(join(path, scoped.name), found);
    } else if (!entry.name.startsWith('.')) {
      await addPackage(path, found);
    }
  }
}

async function addPackage(path: string, found: Set<string>): Promise<void> {
  if (!(await isFile(join(path, 'package.json')))) return;
  const dir = await realpath(path);
  if (found.has(dir)) return;
  found.add(dir);
  await scanNodeModules(join(dir, 'node_modules'), found);
}

/** A package's own bytes: its files, without its nested `node_modules`. */
async function packageBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await entries(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') total += await packageBytes(path);
    } else if (entry.isFile()) {
      total += (await stat(path)).size;
    }
  }
  return total;
}

// ---------------------------------------------------------------------

async function readManifest(dir: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function entries(dir: string) {
  try {
    return (await readdir(dir, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name));
  } catch {
    return [];
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
}

function sortedUnique(names: readonly string[]): string[] {
  return [...new Set(names)].sort(compare);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function count(n: number): string {
  return n.toLocaleString('en-US');
}

/** Bytes as `docker` states sizes: decimal units. */
function size(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} kB`;
  if (bytes < 1_000_000_000) {
    const mb = bytes / 1_000_000;
    return `${mb < 100 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}
