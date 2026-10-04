// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * How a pack image installs the app's dependencies: with the app's own
 * package manager, from its own lockfile, frozen — the versions the app
 * runs locally, not a fresh resolve. The install root is the nearest
 * folder at or above the pack with a lockfile (a monorepo's root), laid
 * out at `/app` in the image with the pack at `/app/<packRel>`.
 *
 * The build context gets only what the install reads: the manifests
 * (the root's and every workspace member's `package.json`), the
 * lockfile, the workspace file, patches, and local `file:` / `link:`
 * dependencies inside the root — those the manifests name, and those
 * overrides (pnpm, npm) or resolutions (yarn) point at. Config that can hold registry
 * credentials (`.npmrc`, `.yarnrc`, `.yarnrc.yml`) is never copied: the
 * install reads it as a build secret.
 *
 * The app's own install scripts never run in the image (`postinstall:
 * prisma generate`, `prepare: husky`): the pack's code is bundled, and
 * what the image needs from such a script is a build extension
 * (`prisma()`). Installing with scripts off isn't enough, since a
 * rebuild (pnpm, npm) then runs the projects' own pending scripts too,
 * so the context's copies of the project manifests leave them out
 * (`withoutInstallScripts`).
 */

import type { Dirent } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { createGlobMatcher } from '@kindgi/handler-runtime';
import { parse as parseYaml } from 'yaml';

import { forbiddenReason } from './context-files.js';

export type ImagePackageManager = 'pnpm' | 'npm' | 'yarn';

/** A config file the install reads as a build secret, never a layer. */
export interface HostSecret {
  /** The BuildKit secret id (`--secret id=<id>,src=<file>`). */
  readonly id: string;
  /** Relative to the install root. */
  readonly file: string;
}

export interface HostInstall {
  /** The install root: the nearest folder at or above the pack with a lockfile. */
  readonly root: string;
  /** The pack folder relative to `root` (`''` when the pack is the root). */
  readonly packRel: string;
  readonly manager: ImagePackageManager;
  /** The root `package.json`'s `packageManager` (`pnpm@11.25.0`): what corepack installs. */
  readonly managerSpec?: string;
  /** Yarn 2+ (a `yarn.lock` with `__metadata`), which installs differently. */
  readonly yarnBerry: boolean;
  /**
   * The root is a workspace with members (`pnpm-workspace.yaml`, or
   * `workspaces`): with pnpm, the image installs only the pack's project
   * and what it depends on.
   */
  readonly workspace: boolean;
  /** The root `package.json`'s `engines.node`. */
  readonly enginesNode?: string;
  /** Files the install reads, relative to `root`, sorted. */
  readonly files: readonly string[];
  /**
   * The app's own project manifests among `files` (the root's, every
   * workspace member's, the pack's), sorted: the context's copies leave
   * out their install scripts. A local dependency's manifest isn't one.
   */
  readonly projectManifests: readonly string[];
  /** The install scripts those manifests have, which the image leaves out, in order. */
  readonly skippedScripts: readonly SkippedScript[];
  /**
   * The pack project's own dependency names, sorted: what the image keeps
   * (`dependencies`, `optionalDependencies`, `peerDependencies`), and what
   * its prune to production drops (`devDependencies`).
   */
  readonly packDependencies: {
    readonly runtime: readonly string[];
    readonly dev: readonly string[];
  };
  readonly secrets: readonly HostSecret[];
}

/** An install script of the app's own that never runs in the image. */
export interface SkippedScript {
  /** The manifest, relative to the install root. */
  readonly manifest: string;
  readonly name: string;
  readonly command: string;
}

export type HostInstallOutcome =
  | { readonly kind: 'ok'; readonly install: HostInstall }
  | { readonly kind: 'err'; readonly message: string };

const LOCKFILES: readonly (readonly [string, ImagePackageManager | 'bun'])[] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
];

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

type Manifest = Readonly<Record<string, unknown>>;

/** What a pack image installs, for the pack at `packDir`. */
export async function resolveHostInstall(packDir: string): Promise<HostInstallOutcome> {
  const found = await findLockfile(resolve(packDir));
  if (found === undefined) {
    return {
      kind: 'err',
      message: `No lockfile at or above ${packDir}. A pack image installs the app's dependencies from its lockfile: run the app's install (pnpm, npm or yarn) so it writes one.`,
    };
  }
  const { root, lockfile, manager } = found;
  if (manager === 'bun') {
    return { kind: 'err', message: `${lockfile}: bun isn't supported for pack images yet; use pnpm, npm or yarn.` };
  }
  const rootManifest = await readManifest(join(root, 'package.json'));
  if (rootManifest === undefined) {
    return { kind: 'err', message: `${join(root, 'package.json')} is missing or isn't JSON.` };
  }
  const managerSpec = stringField(rootManifest, 'packageManager');
  const declared = managerSpec?.split('@')[0];
  if (declared !== undefined && declared !== manager) {
    return {
      kind: 'err',
      message: `package.json says packageManager "${managerSpec}", but the lockfile is ${lockfile} (${manager}). Make them agree.`,
    };
  }

  const files = new Set<string>(['package.json', lockfile]);
  const secrets: HostSecret[] = [];
  let yarnBerry = false;
  let memberPatterns: readonly string[] = [];
  // Where overrides and resolutions can point a package at a local path.
  const overrides: (readonly [string, unknown])[] = [];

  if (manager === 'pnpm') {
    const workspace = await readYaml(join(root, 'pnpm-workspace.yaml'));
    overrides.push(['pnpm-workspace.yaml overrides', workspace?.overrides]);
    if (workspace !== undefined) {
      files.add('pnpm-workspace.yaml');
      memberPatterns = stringList(workspace.packages);
      for (const patch of Object.values(objectField(workspace, 'patchedDependencies'))) {
        if (typeof patch === 'string') files.add(patch);
      }
    }
    const pnpmField = objectField(rootManifest, 'pnpm');
    overrides.push(['package.json pnpm.overrides', pnpmField.overrides]);
    for (const patch of Object.values(objectField(pnpmField, 'patchedDependencies'))) {
      if (typeof patch === 'string') files.add(patch);
    }
    if (await isFile(join(root, '.pnpmfile.cjs'))) files.add('.pnpmfile.cjs');
  } else {
    overrides.push(
      manager === 'npm'
        ? ['package.json overrides', rootManifest.overrides]
        : ['package.json resolutions', rootManifest.resolutions],
    );
    const workspaces = rootManifest.workspaces;
    memberPatterns = Array.isArray(workspaces)
      ? stringList(workspaces)
      : stringList(objectField(rootManifest, 'workspaces').packages);
  }

  if (manager === 'yarn') {
    yarnBerry = (await readFile(join(root, lockfile), 'utf8')).includes('__metadata:');
    if (yarnBerry) {
      const yarnrc = await readYaml(join(root, '.yarnrc.yml'));
      const linker = yarnrc?.nodeLinker;
      if (linker !== 'node-modules') {
        return {
          kind: 'err',
          message: `Yarn ${linker === undefined ? 'Plug’n’Play (the default)' : `nodeLinker "${String(linker)}"`} has no node_modules for a pack image to load packages from: set nodeLinker: node-modules in .yarnrc.yml.`,
        };
      }
      secrets.push({ id: 'yarnrc-yml', file: '.yarnrc.yml' });
      for (const dir of ['.yarn/releases', '.yarn/plugins', '.yarn/patches']) {
        for (const file of await filesUnder(root, dir)) files.add(file);
      }
    } else if (await isFile(join(root, '.yarnrc'))) {
      secrets.push({ id: 'yarnrc', file: '.yarnrc' });
    }
  }
  if (await isFile(join(root, '.npmrc'))) secrets.push({ id: 'npmrc', file: '.npmrc' });

  // Workspace members: their manifests, so a frozen install sees the
  // whole workspace the lockfile describes.
  const memberDirs = await matchDirectories(root, memberPatterns);
  const workspace = memberDirs.some((dir) => dir !== '');
  const manifests: [string, Manifest][] = [['', rootManifest]];
  for (const dir of memberDirs) {
    if (dir === '') continue;
    const manifest = await readManifest(join(root, dir, 'package.json'));
    if (manifest === undefined) continue;
    files.add(`${dir}/package.json`);
    manifests.push([dir, manifest]);
  }
  const packRel = toPosix(relative(root, resolve(packDir)));
  if (packRel !== '' && !files.has(`${packRel}/package.json`)) {
    const manifest = await readManifest(join(root, packRel, 'package.json'));
    if (manifest !== undefined) {
      files.add(`${packRel}/package.json`);
      manifests.push([packRel, manifest]);
    }
  }

  // Local dependencies (`file:` / `link:` / `portal:`) the install reads:
  // those the manifests name (relative to their folder), and those the
  // overrides point at (relative to the root).
  const locals: { readonly name: string; readonly spec: string; readonly base: string; readonly where: string }[] = [];
  for (const [dir, manifest] of manifests) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, spec] of Object.entries(objectField(manifest, field))) {
        if (typeof spec === 'string') {
          locals.push({ name, spec, base: dir, where: `${dir === '' ? '' : `${dir}/`}package.json` });
        }
      }
    }
  }
  for (const [where, value] of overrides) {
    for (const [name, spec] of overrideSpecs(value)) locals.push({ name, spec, base: '', where });
  }
  for (const { name, spec, base, where } of locals) {
    const local = /^(file|link|portal):(.+)$/.exec(spec);
    if (local === null) continue;
    const rel = toPosix(relative(root, resolve(root, base, local[2] ?? '')));
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return {
        kind: 'err',
        message: `${name} is "${spec}" in ${where}, outside the project: a pack image can't install it. Vendor it as a tarball inside the project (file:vendor/<name>.tgz), or install it from a registry.`,
      };
    }
    const added = await addLocalDependency(root, rel, files);
    if (added !== undefined) return { kind: 'err', message: added };
  }

  for (const file of files) {
    const reason = forbiddenReason(file);
    if (reason !== undefined) {
      return { kind: 'err', message: `The install would ship ${file} (${reason}); move it out of the install's inputs.` };
    }
  }

  const enginesNode = stringField(objectField(rootManifest, 'engines'), 'node');
  const packManifest = manifests.find(([dir]) => dir === packRel)?.[1] ?? {};
  const namesIn = (...fields: readonly string[]): string[] =>
    [...new Set(fields.flatMap((field) => Object.keys(objectField(packManifest, field))))].sort();
  return {
    kind: 'ok',
    install: {
      root,
      packRel,
      manager,
      ...(managerSpec !== undefined && { managerSpec }),
      yarnBerry,
      workspace,
      ...(enginesNode !== undefined && { enginesNode }),
      files: [...files].sort(),
      projectManifests: manifests
        .map(([dir]) => (dir === '' ? 'package.json' : `${dir}/package.json`))
        .sort(),
      skippedScripts: manifests
        .map(([dir, manifest]) => [dir === '' ? 'package.json' : `${dir}/package.json`, manifest] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .flatMap(([path, manifest]) =>
          Object.entries(objectField(manifest, 'scripts'))
            .filter(([name, command]) => INSTALL_LIFECYCLE_SCRIPTS.includes(name) && typeof command === 'string')
            .map(([name, command]) => ({ manifest: path, name, command: command as string })),
        ),
      packDependencies: {
        runtime: namesIn('dependencies', 'optionalDependencies', 'peerDependencies'),
        dev: namesIn('devDependencies'),
      },
      secrets,
    },
  };
}

/**
 * The lifecycle scripts a package manager runs for a project on install
 * or rebuild: npm's and pnpm's install hooks, `prepare` and its pre/post,
 * npm's legacy `prepublish` and `dependencies`.
 */
export const INSTALL_LIFECYCLE_SCRIPTS: readonly string[] = [
  'preinstall',
  'install',
  'postinstall',
  'preprepare',
  'prepare',
  'postprepare',
  'prepublish',
  'dependencies',
];

/**
 * A project manifest's text without its install scripts
 * (`INSTALL_LIFECYCLE_SCRIPTS`); every other field, and every other
 * script, stays. A manifest with none comes back byte for byte.
 */
export function withoutInstallScripts(text: string): string {
  const manifest = JSON.parse(text) as Record<string, unknown>;
  const scripts = manifest.scripts;
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) return text;
  const kept = Object.fromEntries(
    Object.entries(scripts).filter(([name]) => !INSTALL_LIFECYCLE_SCRIPTS.includes(name)),
  );
  if (Object.keys(kept).length === Object.keys(scripts).length) return text;
  return `${JSON.stringify({ ...manifest, scripts: kept }, null, 2)}\n`;
}

/** The install, and the prune once build steps that need dev dependencies are done. */
export interface InstallCommands {
  /** Full install, frozen, scripts off; then the allowed build scripts. */
  readonly install: string;
  /** Down to production dependencies. */
  readonly prune: string;
}

export function installCommands(install: HostInstall): InstallCommands {
  switch (install.manager) {
    case 'pnpm': {
      // `rebuild` runs the build scripts the app allows (pnpm's allowBuilds).
      if (!install.workspace) {
        return {
          install: 'pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild',
          prune: 'pnpm prune --prod',
        };
      }
      // A workspace: the pack's project and what it depends on, not the
      // rest of the workspace. The prune is the same filtered install with
      // --prod (`pnpm prune` ignores a filter and installs the whole
      // workspace).
      const only = `--filter '{${install.packRel === '' ? '.' : `./${install.packRel}`}}...'`;
      return {
        install: `pnpm install --frozen-lockfile --ignore-scripts ${only} && pnpm ${only} rebuild`,
        prune: `pnpm install --frozen-lockfile --ignore-scripts --prod ${only}`,
      };
    }
    case 'npm':
      return {
        install: 'npm ci --ignore-scripts --no-audit --no-fund && npm rebuild',
        prune: 'npm prune --omit=dev --no-audit --no-fund',
      };
    case 'yarn':
      return install.yarnBerry
        ? { install: 'yarn install --immutable', prune: 'yarn workspaces focus --all --production' }
        : {
            install:
              'yarn install --frozen-lockfile --ignore-scripts --non-interactive && npm rebuild',
            prune:
              'yarn install --production --frozen-lockfile --ignore-scripts --non-interactive && npm rebuild',
          };
  }
}

// ---------------------------------------------------------------------

async function findLockfile(
  start: string,
): Promise<
  | { readonly root: string; readonly lockfile: string; readonly manager: ImagePackageManager | 'bun' }
  | undefined
> {
  let current = start;
  for (;;) {
    for (const [lockfile, manager] of LOCKFILES) {
      if (await isFile(join(current, lockfile))) return { root: current, lockfile, manager };
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Every `[package, spec]` in overrides or resolutions: a flat map of
 * strings (pnpm, yarn), or npm's nested one (`{ "a": { "b": "1.0.0" } }`,
 * `"."` for the package itself).
 */
function overrideSpecs(value: unknown, parent = ''): (readonly [string, string])[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const out: (readonly [string, string])[] = [];
  for (const [key, spec] of Object.entries(value)) {
    const name = key === '.' ? parent : key;
    if (typeof spec === 'string') out.push([name, spec]);
    else out.push(...overrideSpecs(spec, key));
  }
  return out;
}

/** A `file:` / `link:` dependency inside the root: the tarball, or the folder's files. */
async function addLocalDependency(
  root: string,
  rel: string,
  files: Set<string>,
): Promise<string | undefined> {
  const abs = join(root, rel);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(abs);
  } catch {
    return `The local dependency ${rel} doesn't exist.`;
  }
  if (info.isFile()) {
    files.add(rel);
    return undefined;
  }
  for (const file of await filesUnder(root, rel)) files.add(file);
  return undefined;
}

/** Every file under `dir` (relative to `root`), skipping `node_modules` and `.git`. */
async function filesUnder(root: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) out.push(child);
    }
  };
  await walk(dir);
  return out;
}

/**
 * The folders (relative to `root`) the workspace patterns match:
 * `packages/*`, `apps/**`, `.`, with `!` negations.
 */
async function matchDirectories(root: string, patterns: readonly string[]): Promise<string[]> {
  const include = patterns.filter((p) => !p.startsWith('!')).map(normalizePattern);
  const exclude = patterns.filter((p) => p.startsWith('!')).map((p) => normalizePattern(p.slice(1)));
  if (include.length === 0) return [];
  const included = createGlobMatcher(include);
  const excluded = exclude.length > 0 ? createGlobMatcher(exclude) : () => false;
  const out: string[] = include.includes('') ? [''] : [];
  const deep = include.some((p) => p.includes('**'));
  const maxDepth = deep ? Number.POSITIVE_INFINITY : Math.max(...include.map((p) => p.split('/').length));
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth >= maxDepth) return;
    let entries: Dirent[];
    try {
      entries = await readdir(rel === '' ? root : join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (included(child) && !excluded(child)) out.push(child);
      await walk(child, depth + 1);
    }
  };
  await walk('', 0);
  return out.sort();
}

function normalizePattern(pattern: string): string {
  const trimmed = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  return trimmed === '.' ? '' : trimmed;
}

async function readManifest(path: string): Promise<Manifest | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Manifest)
      : undefined;
  } catch {
    return undefined;
  }
}

async function readYaml(path: string): Promise<Manifest | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  const parsed: unknown = parseYaml(raw);
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Manifest)
    : {};
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function objectField(value: unknown, key: string): Manifest {
  const field = (value as Manifest | undefined)?.[key];
  return field !== null && typeof field === 'object' && !Array.isArray(field) ? (field as Manifest) : {};
}

function stringField(value: Manifest, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field !== '' ? field : undefined;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}
