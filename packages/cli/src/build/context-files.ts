// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The pack's own files in the image — an explicit allowlist, never
 * "the pack directory minus a few folders". A pack embedded in an app
 * has the app's whole tree (and its `.env`) in its directory; copying
 * that put the app's source and secrets into the image.
 *
 * The image runs the pack's bundles, so its source never ships. Of the
 * pack's files, the image holds exactly what `bundle.include` in
 * `kindgi.config.*` lists: files a tool reads at runtime rather than
 * imports. (The install's files are `host-install.ts`'s; the bundles,
 * the Containerfile and the index are the build's own.)
 *
 * Secret-shaped files are refused even when listed: env files,
 * `.kindgirc.json`, `.npmrc`, `.yarnrc.yml`, private keys, and anything
 * under `.git/`, `.kindgi/` or `node_modules/`. A build that would ship
 * one fails, naming it — never a silently different image.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createGlobMatcher, discoveryRoots } from '@kindgi/handler-runtime';

const SECRET_BASENAMES: readonly RegExp[] = [
  /^\.env(\..*)?$/,
  /^\.kindgirc\.json$/,
  /^\.npmrc$/,
  /^\.yarnrc\.yml$/,
  /\.(pem|key|p12|pfx)$/,
  /^id_(rsa|ed25519|ecdsa)(\.pub)?$/,
];
const FORBIDDEN_SEGMENTS = new Set(['.git', '.kindgi', 'node_modules']);

/** Why a relative path must never enter the image, or `undefined`. */
export function forbiddenReason(relPath: string): string | undefined {
  const segments = relPath.split('/');
  const segment = segments.find((s) => FORBIDDEN_SEGMENTS.has(s));
  if (segment !== undefined) return `inside ${segment}/`;
  const base = segments[segments.length - 1] ?? '';
  return SECRET_BASENAMES.some((r) => r.test(base)) ? 'secret-shaped file' : undefined;
}

export interface BundleConfig {
  /** Extra files for the image, as discovery-style globs relative to the pack root. */
  readonly include: readonly string[];
}

/** `bundle` from `kindgi.config.*` — validated; `include` defaults to none. */
export function readBundleConfig(
  config: Readonly<Record<string, unknown>>,
): { readonly kind: 'ok'; readonly bundle: BundleConfig } | { readonly kind: 'invalid'; readonly message: string } {
  const bundle = config.bundle;
  if (bundle === undefined) return { kind: 'ok', bundle: { include: [] } };
  const include = (bundle as { include?: unknown } | null)?.include;
  if (
    typeof bundle !== 'object' ||
    bundle === null ||
    (include !== undefined &&
      (!Array.isArray(include) || !include.every((g) => typeof g === 'string' && g !== '')))
  ) {
    return {
      kind: 'invalid',
      message: '`bundle.include` in kindgi.config.ts must be a list of file globs relative to the pack root.',
    };
  }
  return { kind: 'ok', bundle: { include: (include as string[] | undefined) ?? [] } };
}

export type IncludeFilesResult =
  | { readonly kind: 'ok'; readonly files: readonly string[] }
  | { readonly kind: 'error'; readonly message: string };

/** The files `include` (`bundle.include`) matches, relative to `packDir` (`/`-separated, sorted). */
export async function collectIncludeFiles(
  packDir: string,
  include: readonly string[],
): Promise<IncludeFilesResult> {
  const files = await globFiles(packDir, include);
  const refused = files
    .map((rel) => ({ rel, reason: forbiddenReason(rel) }))
    .filter((f) => f.reason !== undefined);
  if (refused.length > 0) {
    return {
      kind: 'error',
      message: `Refusing to put these files in the image: ${refused.map((f) => `${f.rel} (${f.reason})`).join(', ')}. Remove the \`bundle.include\` entry.`,
    };
  }
  return { kind: 'ok', files: files.sort() };
}

async function globFiles(packDir: string, patterns: readonly string[]): Promise<string[]> {
  if (patterns.length === 0) return [];
  const matches = createGlobMatcher(patterns);
  const out: string[] = [];
  for (const root of discoveryRoots(patterns)) await walk(packDir, root, matches, out);
  return out;
}

async function walk(
  packDir: string,
  rel: string,
  matches: (relPath: string) => boolean,
  out: string[],
): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(rel === '' ? packDir : join(packDir, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (FORBIDDEN_SEGMENTS.has(entry.name)) continue;
    const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) await walk(packDir, child, matches, out);
    else if (entry.isFile() && matches(child)) out.push(child);
  }
}
