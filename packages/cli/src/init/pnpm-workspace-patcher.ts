// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `pnpm-workspace.yaml` patcher for augment mode in a pnpm app. pnpm 11+
 * fails `pnpm install` (`ERR_PNPM_IGNORED_BUILDS`) when a dependency has
 * an install script the workspace hasn't allowed or denied — and
 * `@kindgi/cli` depends on esbuild, which has one. esbuild doesn't need
 * it: its native binary comes from its `@esbuild/<platform>` package, and
 * the script only checks it. So `kindgi init` records the decision that
 * runs nothing, `allowBuilds.esbuild: false`, as the fresh templates' own
 * `pnpm-workspace.yaml` does.
 *
 * The file pnpm reads is the workspace root's: the nearest
 * `pnpm-workspace.yaml` at or above the app (a monorepo's root), else a new
 * one in the app. An existing file is edited as text, so the app's own
 * keys, comments and layout survive; every edit is checked by parsing the
 * result, which must equal the original document with exactly that one
 * change (the `pyproject.toml` patcher's rule). An edit that can't be made
 * that way is refused and the caller tells the user what to add by hand.
 *
 *   - no `allowBuilds` key → an `allowBuilds:` block appended at the end;
 *   - `allowBuilds` without `esbuild` → `esbuild: false` added to it;
 *   - pnpm's placeholder (`esbuild: set this to true or false`, written
 *     by a failed install) → replaced with `false`;
 *   - `esbuild: true` or `false` → the app has decided: nothing to do.
 */

import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { type Node, type Pair, type YAMLMap, isMap, isScalar, parseDocument } from 'yaml';

export const PNPM_WORKSPACE_FILE = 'pnpm-workspace.yaml';

/** The dependency with an install script that Kindgi brings (it bundles the pack). */
export const ESBUILD = 'esbuild';

/** Kindgi's decision for esbuild's install script: off, since esbuild works without it. */
export const ESBUILD_DECISION = false;

/** What pnpm writes for a build it was not told about. */
const PNPM_PLACEHOLDER = 'set this to true or false';

/** The block added to a file without `allowBuilds` (or written as a new file). */
const ALLOW_BUILDS_BLOCK = `# Install scripts pnpm runs (true) or skips (false); pnpm 11 stops an
# install until each one has a decision. esbuild works without its script
# (its binary comes from its @esbuild/<platform> package), so it stays off.
allowBuilds:
  ${ESBUILD}: ${ESBUILD_DECISION}
`;

export type BuildDecisionEdit =
  | {
      readonly kind: 'edited';
      readonly text: string;
      /** `added`: a new entry (or block); `placeholder`: pnpm's placeholder replaced. */
      readonly change: 'added' | 'placeholder';
    }
  /** `allowBuilds.<name>` already holds a decision (`true` or `false`): kept. */
  | { readonly kind: 'decided'; readonly value: boolean }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * Record `value` as the decision for `name`'s install script in a
 * `pnpm-workspace.yaml`'s text, unless it already has one. Pure: the
 * edited text, or why it was left as it is.
 */
export function decideBuildInText(text: string, name: string, value: boolean): BuildDecisionEdit {
  const doc = parseDocument(text);
  const parseError = doc.errors[0];
  if (parseError !== undefined) return refused(`it does not parse: ${parseError.message}`);
  const root = doc.contents;
  if (isNull(root)) return verified(text, appendBlock(text, name, value), name, value, 'added');
  if (!isMap(root) || root.flow === true) return refused('it is not a YAML mapping');

  const allowBuilds = findPair(root, 'allowBuilds');
  if (allowBuilds === undefined) {
    return verified(text, appendBlock(text, name, value), name, value, 'added');
  }
  const builds = allowBuilds.value as Node | null;
  if (isNull(builds)) return addUnderEmptyKey(text, allowBuilds, name, value);
  if (!isMap(builds)) return refused('allowBuilds is not a mapping');

  const entry = findPair(builds, name);
  if (entry !== undefined) return editEntry(text, entry, name, value);
  const edited =
    builds.flow === true
      ? addToFlowMap(text, builds, name, value)
      : addEntry(text, builds, name, value);
  if (edited === undefined) return refused('allowBuilds is laid out in a way init does not edit');
  return verified(text, edited, name, value, 'added');
}

export type PnpmWorkspacePatchResult =
  | { readonly kind: 'created' }
  | { readonly kind: 'patched'; readonly change: 'added' | 'placeholder' }
  /** The app already decided (`true` or `false`): kept. */
  | { readonly kind: 'already-decided'; readonly value: boolean }
  /** Not edited: the caller tells the user what to add by hand. */
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Make sure `pnpm install` has a decision for esbuild's install script
 * (Kindgi's: off): edit the `pnpm-workspace.yaml` at `path`, or create it.
 */
export async function patchPnpmWorkspace(path: string): Promise<PnpmWorkspacePatchResult> {
  let text: string | undefined;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { kind: 'error', message: `Failed to read ${path}: ${(err as Error).message}` };
    }
  }
  const edit = text === undefined ? undefined : decideBuildInText(text, ESBUILD, ESBUILD_DECISION);
  if (edit !== undefined && edit.kind !== 'edited') {
    return edit.kind === 'decided'
      ? { kind: 'already-decided', value: edit.value }
      : { kind: 'refused', reason: edit.reason };
  }
  try {
    await writeFile(path, edit === undefined ? ALLOW_BUILDS_BLOCK : edit.text, 'utf8');
  } catch (err) {
    return { kind: 'error', message: `Failed to write ${path}: ${(err as Error).message}` };
  }
  return edit === undefined ? { kind: 'created' } : { kind: 'patched', change: edit.change };
}

/**
 * The `pnpm-workspace.yaml` pnpm reads for an app at `dir`: the nearest
 * one at or above it (the workspace root), else the app's own (to create).
 */
export async function pnpmWorkspaceFileFor(
  dir: string,
  exists: (path: string) => Promise<boolean> = fileExists,
): Promise<string> {
  for (let current = dir; ; current = dirname(current)) {
    const candidate = join(current, PNPM_WORKSPACE_FILE);
    if (await exists(candidate)) return candidate;
    if (dirname(current) === current) return join(dir, PNPM_WORKSPACE_FILE);
  }
}

// ---------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------

function editEntry(text: string, entry: Pair, name: string, decision: boolean): BuildDecisionEdit {
  const value = entry.value as Node | null;
  if (isScalar(value) && typeof value.value === 'boolean') {
    return { kind: 'decided', value: value.value };
  }
  const range = value?.range;
  if (
    isScalar(value) &&
    typeof value.value === 'string' &&
    value.value.trim().toLowerCase() === PNPM_PLACEHOLDER &&
    range !== undefined &&
    range !== null
  ) {
    const edited = `${text.slice(0, range[0])}${decision}${text.slice(range[1])}`;
    return verified(text, edited, name, decision, 'placeholder');
  }
  return refused(`allowBuilds.${name} is neither true nor false`);
}

/** `allowBuilds:` with nothing under it: `name: <value>` on the next line. */
function addUnderEmptyKey(
  text: string,
  pair: Pair,
  name: string,
  value: boolean,
): BuildDecisionEdit {
  const range = (pair.value as Node | null)?.range;
  // An explicit `null` / `~`, not an empty value.
  if (range !== undefined && range !== null && range[0] !== range[1]) {
    return refused('allowBuilds is null');
  }
  const keyStart = (pair.key as Node).range?.[0] ?? 0;
  const indent = `${lineIndent(text, keyStart) ?? ''}  `;
  const edited = insert(text, lineEnd(text, keyStart), `\n${indent}${name}: ${value}`);
  return verified(text, edited, name, value, 'added');
}

/** `name: <value>` as the last entry of a block `allowBuilds`, at its entries' indent. */
function addEntry(text: string, map: YAMLMap, name: string, value: boolean): string | undefined {
  const firstKey = map.items[0]?.key as Node | undefined;
  const lastItem = map.items[map.items.length - 1];
  const indent = lineIndent(text, firstKey?.range?.[0] ?? -1);
  let end = ((lastItem?.value ?? lastItem?.key) as Node | undefined)?.range?.[1];
  if (indent === undefined || end === undefined) return undefined;
  // A nested value's range can run to the start of the next line.
  while (end > 0 && /\s/.test(text[end - 1] as string)) end -= 1;
  return insert(text, lineEnd(text, end), `\n${indent}${name}: ${value}`);
}

/** `name: <value>` as the last entry of a flow `allowBuilds` (`{ … }`). */
function addToFlowMap(
  text: string,
  map: YAMLMap,
  name: string,
  value: boolean,
): string | undefined {
  const range = map.range;
  if (range === undefined || range === null || text[range[1] - 1] !== '}') return undefined;
  let last = range[1] - 2;
  while (last > range[0] && /\s/.test(text[last] as string)) last -= 1;
  if (last === range[0])
    return `${text.slice(0, range[0])}{ ${name}: ${value} }${text.slice(range[1])}`;
  const entry = `${name}: ${value}`;
  return insert(text, last + 1, text[last] === ',' ? ` ${entry}` : `, ${entry}`);
}

function appendBlock(text: string, name: string, value: boolean): string {
  const block =
    name === ESBUILD && value === ESBUILD_DECISION
      ? ALLOW_BUILDS_BLOCK
      : `allowBuilds:\n  ${name}: ${value}\n`;
  if (text.trim() === '') return `${text}${block}`;
  return `${text.endsWith('\n') ? text : `${text}\n`}\n${block}`;
}

// ---------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------

/**
 * `after`, if it parses to exactly `before`'s document with
 * `allowBuilds.<name>` set to `value`; refused otherwise.
 */
function verified(
  before: string,
  after: string,
  name: string,
  value: boolean,
  change: 'added' | 'placeholder',
): BuildDecisionEdit {
  const wanted = toPlain(before);
  const got = toPlain(after);
  if (wanted === undefined || got === undefined) return refused('the edit would not parse');
  const doc = isRecord(wanted) ? { ...wanted } : {};
  doc.allowBuilds = { ...(isRecord(doc.allowBuilds) ? doc.allowBuilds : {}), [name]: value };
  return isDeepStrictEqual(got, doc)
    ? { kind: 'edited', text: after, change }
    : refused('the edit would change more than intended');
}

/** The document as plain JSON values; `undefined` when it doesn't parse. */
function toPlain(text: string): unknown {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return undefined;
  return JSON.parse(JSON.stringify(doc.toJS() ?? {}));
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/** No document, or a `null` value. */
function isNull(node: unknown): boolean {
  return node === null || node === undefined || (isScalar(node) && node.value === null);
}

function findPair(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((p) => isScalar(p.key) && p.key.value === key);
}

/** The whitespace before `offset` on its line; `undefined` when other text precedes it. */
function lineIndent(text: string, offset: number): string | undefined {
  if (offset < 0) return undefined;
  const indent = text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset);
  return /^[ \t]*$/.test(indent) ? indent : undefined;
}

function lineEnd(text: string, from: number): number {
  const nl = text.indexOf('\n', from);
  return nl === -1 ? text.length : nl;
}

function insert(text: string, at: number, what: string): string {
  return `${text.slice(0, at)}${what}${text.slice(at)}`;
}

function refused(reason: string): BuildDecisionEdit {
  return { kind: 'refused', reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
