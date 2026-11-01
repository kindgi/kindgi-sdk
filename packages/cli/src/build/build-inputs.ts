// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `build-inputs.json`: what `kindgi build` made a deploy envelope from,
 * written beside it in `--out`. `kindgi deploy` reads it to tell whether
 * the pack changed since that build, and builds again when it did. It's
 * local only: it's never sent, and it isn't in the signed envelope.
 */

import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { parseJsonc, resolveExtends } from '../init/tsconfig-paths.js';
import { sha256Hex } from './envelope.js';

export const BUILD_INPUTS_FILE = 'build-inputs.json';

/**
 * The build options an envelope depends on, as the build resolved them
 * (`buildInputOptionsOf` in `commands/build.ts`). The tenant and the key
 * id are from before their fallbacks, the hosted key's own tenant and the
 * key file's name, which a deploy can't repeat without the key. A deploy
 * that names no tenant or key id, pins no version or time, or doesn't
 * pass `--skip-sign`, takes the build's (`changedSince`).
 */
export interface BuildInputOptions {
  readonly env: string;
  readonly target: string;
  readonly hosted: boolean;
  readonly skipSign: boolean;
  /** `--tenant`, else the env block's, else `KINDGI_TENANT_ID`. */
  readonly tenantId?: string;
  /** `--signer-key-id`, else the env block's. */
  readonly signerKeyId?: string;
  /** Only when pinned with `--artifact-version`: by default it's the build's time. */
  readonly artifactVersion?: string;
  /** Only when pinned with `--published-at`. */
  readonly publishedAt?: string;
}

export interface BuildInputs {
  /** The CLI that built it: the bundler and the Containerfile come with it. */
  readonly cliVersion: string;
  /** The envelope written with it: a stamp vouches only for that file. */
  readonly envelopeSha256: string;
  readonly options: BuildInputOptions;
  /** Each file the image was made from, relative to the pack (`/`-separated), and its sha256. */
  readonly files: Readonly<Record<string, string>>;
  /**
   * A TypeScript pack: the files its bundles were built from, relative to
   * the pack. They're in `files` too; the tsconfigs that apply to them are
   * found from them.
   */
  readonly sources: readonly string[];
}

/** What deploy compares with a stamp: the pack and the options as they are now. */
export interface CurrentInputs {
  readonly cliVersion: string;
  readonly options: BuildInputOptions;
  readonly files: Readonly<Record<string, string>>;
}

/**
 * The sha256 of each of a pack's input files, by its path relative to the
 * pack: `walked` (what the build context is made of), `sources` and the
 * tsconfigs that apply to them, and any `also` (the files a stamp named).
 * A file that isn't there is left out.
 */
export async function hashInputs(
  packDir: string,
  walked: readonly string[],
  sources: readonly string[],
  also: readonly string[] = [],
): Promise<Record<string, string>> {
  const paths = new Set([...walked, ...sources, ...(await tsconfigsOf(sources)), ...also]);
  const files: Record<string, string> = {};
  for (const path of [...paths].sort()) {
    const hash = await fileSha256(path);
    if (hash !== undefined) files[packRelative(packDir, path)] = hash;
  }
  return files;
}

/** `path` relative to the pack, with `/` separators. */
export function packRelative(packDir: string, path: string): string {
  return relative(packDir, path).split(sep).join('/');
}

/** A stamp's pack-relative paths, absolute again. */
export function fromPack(packDir: string, paths: Iterable<string>): string[] {
  return [...paths].map((path) => resolve(packDir, path));
}

/**
 * The tsconfigs esbuild applies to `sources`: for each one, the nearest
 * `tsconfig.json` (else `jsconfig.json`) at or above its folder, and every
 * config it extends by path. The build passes esbuild none, and esbuild's
 * metafile doesn't list the ones it finds. One extended from a package is
 * in `node_modules`, which the lockfile covers.
 */
export async function tsconfigsOf(sources: readonly string[]): Promise<string[]> {
  const nearest = new Map<string, string | undefined>();
  const found = new Set<string>();
  for (const source of sources) {
    const config = await nearestTsconfig(dirname(source), nearest);
    if (config !== undefined) await withExtends(config, found);
  }
  return [...found].sort();
}

async function nearestTsconfig(
  dir: string,
  nearest: Map<string, string | undefined>,
): Promise<string | undefined> {
  if (nearest.has(dir)) return nearest.get(dir);
  let config: string | undefined;
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    if (await isFile(join(dir, name))) {
      config = join(dir, name);
      break;
    }
  }
  const parent = dirname(dir);
  if (config === undefined && parent !== dir) config = await nearestTsconfig(parent, nearest);
  nearest.set(dir, config);
  return config;
}

async function withExtends(config: string, found: Set<string>): Promise<void> {
  if (found.has(config)) return;
  found.add(config);
  let parsed: unknown;
  try {
    parsed = parseJsonc(await readFile(config, 'utf8'));
  } catch {
    return;
  }
  const ext = isRecord(parsed) ? parsed.extends : undefined;
  const specs = typeof ext === 'string' ? [ext] : Array.isArray(ext) ? ext : [];
  for (const spec of specs) {
    if (typeof spec !== 'string') continue;
    const target = resolveExtends(spec, config);
    if (target === undefined || target.split(sep).includes('node_modules')) continue;
    await withExtends(target, found);
  }
}

export async function writeBuildInputs(outDir: string, inputs: BuildInputs): Promise<void> {
  await writeFile(join(outDir, BUILD_INPUTS_FILE), `${JSON.stringify(inputs, null, 2)}\n`, 'utf8');
}

/** The stamp in `dir`; `undefined` when there's none, or it isn't one. */
export async function readBuildInputs(dir: string): Promise<BuildInputs | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(dir, BUILD_INPUTS_FILE), 'utf8'));
  } catch {
    return undefined;
  }
  return isBuildInputs(parsed) ? parsed : undefined;
}

/**
 * What changed since the stamp's build, the first thing that did, as a
 * deploy line says it: `` `tools/lookup/index.ts` is new, and 2 more ``,
 * `` it was built for `--env=staging` ``. `undefined` when nothing did.
 */
export function changedSince(stamp: BuildInputs, now: CurrentInputs): string | undefined {
  if (stamp.cliVersion !== now.cliVersion) return `it was built with kindgi ${stamp.cliVersion}`;
  for (const [key, flag, ifSet] of OPTION_FLAGS) {
    const was = stamp.options[key];
    const is = now.options[key];
    if (was === is || (ifSet && (is === undefined || is === false))) continue;
    if (typeof was === 'boolean') return `it was built ${was ? 'with' : 'without'} \`${flag}\``;
    return was === undefined
      ? `it was built with no \`${flag}\``
      : `it was built for \`${flag}=${was}\``;
  }
  const changes: string[] = [];
  for (const path of new Set([...Object.keys(stamp.files), ...Object.keys(now.files)])) {
    const was = stamp.files[path];
    const is = now.files[path];
    if (was === is) continue;
    changes.push(
      `\`${path}\` ${was === undefined ? 'is new' : is === undefined ? 'is gone' : 'changed'}`,
    );
  }
  if (changes.length === 0) return undefined;
  changes.sort();
  return changes.length === 1 ? changes[0] : `${changes[0]}, and ${changes.length - 1} more`;
}

/**
 * Each option, in the order a change is named, its flag, and whether it
 * counts only when the deploy sets it. A deploy that names no tenant
 * sends the envelope's, as it always has (the server checks it against
 * the token's); one that names no key id takes the one the envelope was
 * signed with, as it needn't repeat `--signing-key`; one that pins no
 * version or time takes the build's, as it does an unpinned build's; and
 * one without `--skip-sign` sends an unsigned envelope only to
 * `--dry-run`, as before. The env, the target and where it was built
 * must match: left out, they're the defaults the deploy would build with.
 */
const OPTION_FLAGS: readonly (readonly [keyof BuildInputOptions, string, boolean])[] = [
  ['env', '--env', false],
  ['tenantId', '--tenant', true],
  ['target', '--target', false],
  ['hosted', '--hosted', false],
  ['skipSign', '--skip-sign', true],
  ['signerKeyId', '--signer-key-id', true],
  ['artifactVersion', '--artifact-version', true],
  ['publishedAt', '--published-at', true],
];

function isBuildInputs(value: unknown): value is BuildInputs {
  if (!isRecord(value)) return false;
  const { options, files, sources } = value;
  return (
    typeof value.cliVersion === 'string' &&
    typeof value.envelopeSha256 === 'string' &&
    isRecord(options) &&
    typeof options.env === 'string' &&
    typeof options.target === 'string' &&
    typeof options.hosted === 'boolean' &&
    typeof options.skipSign === 'boolean' &&
    ['tenantId', 'signerKeyId', 'artifactVersion', 'publishedAt'].every(
      (key) => options[key] === undefined || typeof options[key] === 'string',
    ) &&
    isRecord(files) &&
    Object.values(files).every((hash) => typeof hash === 'string') &&
    Array.isArray(sources) &&
    sources.every((source) => typeof source === 'string')
  );
}

async function fileSha256(path: string): Promise<string | undefined> {
  try {
    return await sha256Hex(new Uint8Array(await readFile(path)));
  } catch {
    return undefined;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
