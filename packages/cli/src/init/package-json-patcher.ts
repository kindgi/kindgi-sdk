// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `package.json` patcher for augment mode. Makes Kindgi a project
 * dependency — `@kindgi/sdk` in `dependencies`, `@kindgi/cli` in
 * `devDependencies`, so the project runs its own pinned `kindgi` —
 * while preserving the rest of the file:
 *
 *   - Indent (2-space or 4-space, auto-detected from the first
 *     indented key)
 *   - Trailing-newline convention (preserved verbatim)
 *   - Field order (unrelated fields never reordered)
 *
 * Idempotency: a package already declared in ANY dependency section
 * is left exactly where it is (the user's placement and spec win).
 *
 * Specs come from `resolveKindgiDependencySpecs` (`dependency-specs.ts`)
 * — the same answer fresh mode uses. Never `latest`.
 */

import { readFile, writeFile } from 'node:fs/promises';

import type { KindgiDependencySpecs } from './dependency-specs.js';

export const KINDGI_SDK_PKG = '@kindgi/sdk';
export const KINDGI_CLI_PKG = '@kindgi/cli';

/** A package `patchPackageJson` adds when no dependency section declares it. */
export interface WantedDependency {
  readonly name: string;
  readonly spec: string;
  readonly section: 'dependencies' | 'devDependencies';
}

export type PatchResult =
  | { readonly kind: 'patched'; readonly added: readonly string[] }
  | { readonly kind: 'already-present' }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Read `package.json`, add whichever of `@kindgi/sdk` / `@kindgi/cli`
 * (and `extra`) is missing, write it back preserving format. Never
 * touches the file when all are already declared.
 */
export async function patchPackageJson(
  pkgJsonPath: string,
  specs: Pick<KindgiDependencySpecs, 'sdk' | 'cli'>,
  extra: readonly WantedDependency[] = [],
): Promise<PatchResult> {
  let raw: string;
  try {
    raw = await readFile(pkgJsonPath, 'utf8');
  } catch (err) {
    return { kind: 'error', message: `Failed to read ${pkgJsonPath}: ${(err as Error).message}` };
  }

  let parsed: Record<string, unknown>;
  try {
    const p = JSON.parse(raw) as unknown;
    if (p === null || typeof p !== 'object' || Array.isArray(p)) {
      return { kind: 'error', message: `${pkgJsonPath} is not a JSON object.` };
    }
    parsed = p as Record<string, unknown>;
  } catch (err) {
    return {
      kind: 'error',
      message: `${pkgJsonPath} is not valid JSON: ${(err as Error).message}`,
    };
  }

  const wanted: readonly WantedDependency[] = [
    { name: KINDGI_SDK_PKG, spec: specs.sdk, section: 'dependencies' },
    { name: KINDGI_CLI_PKG, spec: specs.cli, section: 'devDependencies' },
    ...extra,
  ];
  const missing = wanted.filter((w) => !isDepPresent(parsed, w.name));
  if (missing.length === 0) return { kind: 'already-present' };

  const next: Record<string, unknown> = { ...parsed };
  for (const w of missing) {
    const bucket = isRecord(next[w.section])
      ? { ...(next[w.section] as Record<string, unknown>) }
      : {};
    bucket[w.name] = w.spec;
    next[w.section] = sortByKey(bucket);
  }
  const emitted = JSON.stringify(next, null, detectIndent(raw)) + (raw.endsWith('\n') ? '\n' : '');

  try {
    await writeFile(pkgJsonPath, emitted, 'utf8');
  } catch (err) {
    return { kind: 'error', message: `Failed to write ${pkgJsonPath}: ${(err as Error).message}` };
  }
  return { kind: 'patched', added: missing.map((w) => w.name) };
}

// ---------------------------------------------------------------------
// Helpers — exported for tests
// ---------------------------------------------------------------------

/**
 * Detect the indent width used in a JSON file. Reads until the first
 * indented line (a line starting with whitespace), counts the run.
 * Falls back to 2 spaces if nothing looks indented (single-line JSON).
 */
export function detectIndent(raw: string): number {
  const lines = raw.split('\n');
  for (const line of lines) {
    const match = line.match(/^(\s+)/);
    if (match !== null) {
      const ws = match[1] ?? '';
      // Tabs → treat as 4 spaces of JSON.stringify indent (JS's
      // JSON.stringify only accepts number-or-string, so we return a
      // number; tab-indented files get re-emitted with 4-space
      // indent. Acceptable rare-case regression.
      if (ws.includes('\t')) return 4;
      return ws.length;
    }
  }
  return 2;
}

/**
 * True iff the dep appears in `dependencies`, `devDependencies`,
 * `peerDependencies`, or `optionalDependencies` sections.
 */
export function isDepPresent(pkg: Record<string, unknown>, name: string): boolean {
  const sections = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ] as const;
  for (const s of sections) {
    const bucket = pkg[s];
    if (isRecord(bucket) && Object.prototype.hasOwnProperty.call(bucket, name)) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sortByKey(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = obj[key];
  }
  return out;
}
