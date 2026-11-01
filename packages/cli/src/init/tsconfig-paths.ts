// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An app's TypeScript path aliases (`compilerOptions.paths` in its
 * `tsconfig.json`, following `extends`), for the vitest config `kindgi
 * init` adds: vitest doesn't read tsconfig, so without them a tool that
 * imports `@/lib/orders` builds with the app and fails under `kindgi test`.
 * Read once, at init, and written into that config as `resolve.alias`.
 */

import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface PathAlias {
  /** The tsconfig pattern: `@/*`, or an exact name. */
  readonly pattern: string;
  /** Where it points, relative to the app's folder, with `/` separators: `src/*`, `../ui/src/*`. */
  readonly target: string;
}

export interface TsconfigPaths {
  /** In the order to try them: exact names, then the longest prefix first (TypeScript's choice). */
  readonly aliases: readonly PathAlias[];
  /** What couldn't be carried over as it is, for init's summary. */
  readonly notes: readonly string[];
}

const NO_PATHS: TsconfigPaths = { aliases: [], notes: [] };

/** How deep an `extends` chain is followed. */
const MAX_EXTENDS_DEPTH = 16;

interface ConfigLevel {
  readonly dir: string;
  readonly compilerOptions: Readonly<Record<string, unknown>>;
  /** It lists project `references` (a solution-style tsconfig.json). */
  readonly references: boolean;
}

/**
 * `<appDir>/tsconfig.json`'s path aliases. No tsconfig, or one without
 * `paths`: none. `paths` and `baseUrl` come from the nearest config that
 * sets each (the app's own, then what it extends, the last of an array
 * first); targets resolve against `baseUrl`, else the folder of the config
 * that sets `paths`; a leading `${configDir}` is the app's folder, as
 * TypeScript has it. A target list's first entry is used (vitest has no
 * fallback), and a pattern starting with `*` is left out (vitest would
 * send every import, packages too, through it).
 */
export async function readTsconfigPaths(appDir: string): Promise<TsconfigPaths> {
  // Real paths throughout: a package's tsconfig resolves to one (Node,
  // like TypeScript, follows pnpm's links), and a target is relative to
  // the folder of the config that names it.
  const app = await realOrResolved(appDir);
  const start = join(app, 'tsconfig.json');
  const unread: string[] = [];
  const levels = await collectLevels(start, new Set(), 0, unread);
  if (levels === undefined) return NO_PATHS;

  const withPaths = levels.find((l) => isRecord(l.compilerOptions.paths));
  if (withPaths === undefined) {
    const notes = unread.map(
      (spec) =>
        `tsconfig.json extends ${spec}, which init couldn't read: any paths it sets aren't in vitest's aliases.`,
    );
    if (levels[0]?.references === true) {
      notes.push(
        "tsconfig.json has project references, and init reads only its own paths: copy any the referenced configs set into vitest's aliases.",
      );
    }
    return { aliases: [], notes };
  }
  const withBaseUrl = levels.find((l) => typeof l.compilerOptions.baseUrl === 'string');
  const base =
    withBaseUrl !== undefined
      ? resolve(withBaseUrl.dir, inConfigDir(withBaseUrl.compilerOptions.baseUrl as string, app))
      : withPaths.dir;

  const aliases: PathAlias[] = [];
  const notes: string[] = [];
  const paths = withPaths.compilerOptions.paths as Record<string, unknown>;
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets)) continue;
    const first = targets.find((t): t is string => typeof t === 'string');
    if (first === undefined) continue;
    if (pattern.startsWith('*')) {
      notes.push(
        `tsconfig.json's paths map "${pattern}", which would catch every import in vitest, packages too: left out of its aliases.`,
      );
      continue;
    }
    if (targets.length > 1) {
      notes.push(
        `tsconfig.json maps "${pattern}" to ${targets.length} places; vitest's alias takes the first, ${first}.`,
      );
    }
    aliases.push({ pattern, target: fromApp(app, resolve(base, inConfigDir(first, app))) });
  }
  return { aliases: aliases.sort(byPrecedence), notes };
}

/**
 * The config at `file` and what it extends, nearest first; `undefined`
 * when `file` can't be read. An `extends` that can't be resolved or read
 * is recorded in `unread` and skipped.
 */
async function collectLevels(
  file: string,
  seen: Set<string>,
  depth: number,
  unread: string[],
): Promise<readonly ConfigLevel[] | undefined> {
  if (seen.has(file) || depth > MAX_EXTENDS_DEPTH) return [];
  seen.add(file);
  const parsed = await readJsonc(file);
  if (!isRecord(parsed)) return undefined;

  const compilerOptions = isRecord(parsed.compilerOptions) ? parsed.compilerOptions : {};
  const levels: ConfigLevel[] = [
    {
      dir: dirname(await realOrResolved(file)),
      compilerOptions,
      references: Array.isArray(parsed.references),
    },
  ];
  const ext = parsed.extends;
  const specs = typeof ext === 'string' ? [ext] : Array.isArray(ext) ? ext : [];
  // A later entry of an `extends` array overrides an earlier one.
  for (const spec of [...specs].reverse()) {
    if (typeof spec !== 'string') continue;
    const target = resolveExtends(spec, file);
    const inner =
      target === undefined ? undefined : await collectLevels(target, seen, depth + 1, unread);
    if (inner === undefined) unread.push(spec);
    else levels.push(...inner);
  }
  return levels;
}

/** Where an `extends` entry points: a path from the config's folder, or a package's tsconfig. */
export function resolveExtends(spec: string, from: string): string | undefined {
  if (spec.startsWith('./') || spec.startsWith('../') || isAbsolute(spec)) {
    const path = resolve(dirname(from), spec);
    return path.endsWith('.json') ? path : `${path}.json`;
  }
  const require = createRequire(from);
  for (const candidate of [spec, `${spec}/tsconfig.json`, `${spec}.json`]) {
    try {
      return require.resolve(candidate);
    } catch {
      // try the next form
    }
  }
  return undefined;
}

/**
 * A path with TypeScript's `${configDir}` (5.5+) at its start made
 * absolute: it names the folder of the tsconfig in use, the app's, even
 * when a config it extends writes it.
 */
function inConfigDir(path: string, app: string): string {
  return path.startsWith(CONFIG_DIR) ? join(app, path.slice(CONFIG_DIR.length)) : path;
}

const CONFIG_DIR = '${configDir}';

/** `path`'s real path, or `path` resolved when it has none. */
async function realOrResolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/** `path` relative to the app's real folder, with `/` separators; the app itself is `.`. */
function fromApp(app: string, path: string): string {
  const rel = relative(app, path).split(sep).join('/');
  return rel === '' ? '.' : rel;
}

/** Exact names first, then wildcards by the length of what precedes the `*`, longest first. */
function byPrecedence(a: PathAlias, b: PathAlias): number {
  const prefix = (p: string): number =>
    p.includes('*') ? p.indexOf('*') : Number.MAX_SAFE_INTEGER;
  return prefix(b.pattern) - prefix(a.pattern);
}

async function readJsonc(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return parseJsonc(text);
  } catch {
    return undefined;
  }
}

/**
 * JSON as tsconfig files are written: with `//` and `/* *\/` comments
 * and trailing commas, which TypeScript accepts and `JSON.parse` doesn't.
 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(withoutTrailingCommas(withoutComments(text.replace(/^﻿/, ''))));
}

/** The text with its comments blanked, strings untouched. */
function withoutComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      i = commentEnd(text, i);
      out += ' ';
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** The index just past the comment opening at `start`: a `//` one ends before its newline. */
function commentEnd(text: string, start: number): number {
  if (text[start + 1] === '/') {
    const newline = text.indexOf('\n', start);
    return newline === -1 ? text.length : newline;
  }
  const close = text.indexOf('*/', start + 2);
  return close === -1 ? text.length : close + 2;
}

/** Whitespace, then a `}` or `]`, from `lastIndex`. */
const CLOSER_AHEAD = /\s*[}\]]/y;

/** The text without a `,` that only whitespace separates from a `}` or `]`, strings untouched. */
function withoutTrailingCommas(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    CLOSER_AHEAD.lastIndex = i + 1;
    if (c === ',' && CLOSER_AHEAD.test(text)) {
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** The index just past the string literal opening at `start`. */
function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
  return Math.min(i + 1, text.length);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
