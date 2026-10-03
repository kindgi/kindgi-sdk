// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Edits to an existing app's `pyproject.toml` for `kindgi init` in a
 * Python app — as text, so the app's own layout, comments and key order
 * survive: add `kindgi` to `[project].dependencies`, add a `[tool.uv.sources]`
 * entry, append the `[tool.kindgi]` tables.
 *
 * Every edit is checked by parsing the result: it must parse, and it must
 * equal the original document with exactly the intended change. An edit
 * that can't be made that way is refused (the caller tells the user what
 * to add by hand) rather than risk the app's file.
 */

import { isDeepStrictEqual } from 'node:util';

import { parse } from 'smol-toml';

type Doc = Record<string, unknown>;

/** How the app declares its dependencies — whether `kindgi init` can add one. */
export type DependencyStyle =
  /** `[project].dependencies` (PEP 621): editable. */
  | 'pep621'
  /** `dependencies` is in `[project].dynamic` (setuptools reading a file). */
  | 'dynamic'
  /** No `[project]` table — Poetry 1's `[tool.poetry]`, `setup.py`, …. */
  | 'none';

export interface PyprojectInfo {
  readonly name: string | undefined;
  readonly version: string | undefined;
  /** It already has a `[tool.kindgi]` table — it is a pack. */
  readonly isPack: boolean;
  readonly dependencyStyle: DependencyStyle;
  /** `kindgi` is already one of `[project].dependencies`. */
  readonly hasKindgiDependency: boolean;
  /** `[tool.poetry]` is present. */
  readonly usesPoetry: boolean;
  /** `[tool.uv]` is present, or the build backend is `uv_build`. */
  readonly usesUv: boolean;
  /** `[tool.uv] required-version`, when set. */
  readonly uvRequiredVersion: string | undefined;
}

type Edit =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'err'; readonly message: string };

export function readPyproject(
  text: string,
):
  | { readonly kind: 'ok'; readonly info: PyprojectInfo }
  | { readonly kind: 'err'; readonly message: string } {
  let doc: Doc;
  try {
    doc = parse(text) as Doc;
  } catch (err) {
    return { kind: 'err', message: `pyproject.toml does not parse: ${(err as Error).message}` };
  }
  const project = record(doc.project);
  const tool = record(doc.tool);
  const dynamic = Array.isArray(project?.dynamic) ? project.dynamic : [];
  const deps = Array.isArray(project?.dependencies) ? project.dependencies : [];
  return {
    kind: 'ok',
    info: {
      // A Poetry 1 app names itself under [tool.poetry].
      name: stringAt(project, 'name') ?? stringAt(record(tool?.poetry), 'name'),
      version: stringAt(project, 'version') ?? stringAt(record(tool?.poetry), 'version'),
      isPack: tool?.kindgi !== undefined,
      dependencyStyle:
        project === undefined ? 'none' : dynamic.includes('dependencies') ? 'dynamic' : 'pep621',
      hasKindgiDependency: deps.some(
        (d) => typeof d === 'string' && requirementName(d) === 'kindgi',
      ),
      usesPoetry: tool?.poetry !== undefined,
      usesUv:
        tool?.uv !== undefined || record(doc['build-system'])?.['build-backend'] === 'uv_build',
      uvRequiredVersion: stringAt(record(tool?.uv), 'required-version'),
    },
  };
}

/** The normalized distribution name of a requirement (`Kindgi[x]>=1` → `kindgi`). */
export function requirementName(requirement: string): string {
  const name = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(requirement)?.[1] ?? '';
  return normalizeName(name);
}

/** PEP 503 normalization: lowercase, runs of `-`, `_`, `.` become `-`. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** Add `requirement` to `[project].dependencies` (creating the key if absent). */
export function addProjectDependency(text: string, requirement: string): Edit {
  const lines = scanLines(text);
  const header = lines.find((l) => l.header === 'project' && l.arrayTable !== true);
  if (header === undefined) return { kind: 'err', message: 'no [project] table' };
  const end = tableEnd(lines, header, text.length);
  const key = lines.find(
    (l) => l.start > header.start && l.start < end && l.depth === 0 && l.key === 'dependencies',
  );
  let edited: string;
  if (key === undefined) {
    const at = lineEnd(text, header.start);
    edited = `${text.slice(0, at)}\ndependencies = [${JSON.stringify(requirement)}]${text.slice(at)}`;
  } else {
    const open = text.indexOf('[', text.indexOf('=', key.start));
    const close = open === -1 ? -1 : matchingBracket(text, open);
    if (close === -1) return { kind: 'err', message: '[project].dependencies is not an array' };
    edited = insertIntoArray(text, open, close, JSON.stringify(requirement));
  }
  return verified(text, edited, (doc) => {
    const project = record(doc.project);
    const deps = Array.isArray(project?.dependencies) ? [...project.dependencies] : [];
    if (project !== undefined) doc.project = { ...project, dependencies: [...deps, requirement] };
  });
}

/** Add `name = <inlineTable>` under `[tool.uv.sources]` (creating the table at the end if absent). */
export function addUvSource(text: string, name: string, inlineTable: string): Edit {
  return addTableKey(text, 'tool.uv.sources', name, inlineTable);
}

/**
 * Set `key = <tomlValue>` in the table `dotted` (e.g. `tool.uv`): right
 * under its header, or in a new table at the end of the file. The key must
 * not be set yet (the verification refuses otherwise).
 */
export function addTableKey(text: string, dotted: string, key: string, tomlValue: string): Edit {
  const lines = scanLines(text);
  const header = lines.find((l) => l.header === dotted && l.arrayTable !== true);
  const entry = `${key} = ${tomlValue}`;
  const edited =
    header === undefined
      ? `${withTrailingNewline(text)}\n[${dotted}]\n${entry}\n`
      : `${text.slice(0, lineEnd(text, header.start))}\n${entry}${text.slice(lineEnd(text, header.start))}`;
  const value = parse(`v = ${tomlValue}`).v;
  return verified(text, edited, (doc) => {
    let table: Doc = doc;
    for (const part of dotted.split('.')) {
      const next = { ...(record(table[part]) ?? {}) };
      table[part] = next;
      table = next;
    }
    if (Object.hasOwn(table, key)) throw new Error(`${dotted}.${key} is set already`);
    table[key] = value;
  });
}

/** Append `block` (whole tables) at the end of the file; it must add exactly `expected`. */
export function appendTables(text: string, block: string, expected: Doc): Edit {
  const edited = `${withTrailingNewline(text)}\n${block}`;
  return verified(text, edited, (doc) => mergeInto(doc, expected));
}

// ---------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------

function verified(before: string, after: string, intend: (doc: Doc) => void): Edit {
  let wanted: Doc;
  let got: Doc;
  try {
    wanted = parse(before) as Doc;
    intend(wanted);
    got = parse(after) as Doc;
  } catch (err) {
    return { kind: 'err', message: `the edit would not parse: ${(err as Error).message}` };
  }
  return isDeepStrictEqual(plain(got), plain(wanted))
    ? { kind: 'ok', text: after }
    : { kind: 'err', message: 'the edit would change more than intended' };
}

/** A parsed document as plain JSON values (smol-toml dates become strings). */
function plain(doc: Doc): unknown {
  return JSON.parse(JSON.stringify(doc));
}

function mergeInto(target: Doc, add: Doc): void {
  for (const [key, value] of Object.entries(add)) {
    const existing = record(target[key]);
    const incoming = record(value);
    if (existing !== undefined && incoming !== undefined) {
      const copy = { ...existing };
      mergeInto(copy, incoming);
      target[key] = copy;
    } else {
      target[key] = value;
    }
  }
}

function stringAt(table: Doc | undefined, key: string): string | undefined {
  const value = table?.[key];
  return typeof value === 'string' ? value : undefined;
}

function record(value: unknown): Doc | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Doc)
    : undefined;
}

// ---------------------------------------------------------------------
// A line scanner — enough TOML to find tables and top-level keys
// ---------------------------------------------------------------------

interface Line {
  /** Offset of the line's first character. */
  readonly start: number;
  /** Bracket depth at the line's start (0 = not inside a value). */
  readonly depth: number;
  /** The table a `[header]` line opens, or the array of tables a `[[header]]` line extends. */
  readonly header?: string;
  /** `true` for a `[[header]]` line. */
  readonly arrayTable?: boolean;
  /** The bare key a `key = …` line sets. */
  readonly key?: string;
}

function scanLines(text: string): Line[] {
  const lines: Line[] = [];
  let depth = 0;
  let quote: '"' | "'" | '"""' | "'''" | undefined;
  for (let i = 0; i <= text.length; ) {
    if (quote === undefined && (i === 0 || text[i - 1] === '\n'))
      lines.push(describeLine(text, i, depth));
    if (i === text.length) break;
    const ch = text[i] as string;
    if (quote !== undefined) {
      if (ch === '\\' && (quote === '"' || quote === '"""')) i += 2;
      else if (text.startsWith(quote, i)) {
        i += quote.length;
        quote = undefined;
      } else i += 1;
      continue;
    }
    if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      quote = text.slice(i, i + 3) as '"""' | "'''";
      i += 3;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
    } else if (ch === '#') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
    } else {
      if (ch === '[' || ch === '{') depth += 1;
      if (ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
      i += 1;
    }
  }
  return lines;
}

function describeLine(text: string, start: number, depth: number): Line {
  const content = text.slice(start, lineEnd(text, start)).trim();
  if (depth === 0 && content.startsWith('[')) {
    const arrayTable = content.startsWith('[[');
    const name = (arrayTable ? /^\[\[\s*([^\]]+?)\s*\]\]/ : /^\[\s*([^\]]+?)\s*\]/).exec(
      content,
    )?.[1];
    if (name === undefined) return { start, depth };
    const header = name.replace(/\s*\.\s*/g, '.');
    return arrayTable ? { start, depth, header, arrayTable } : { start, depth, header };
  }
  const key = /^([A-Za-z0-9_-]+)\s*=/.exec(content)?.[1];
  return key === undefined ? { start, depth } : { start, depth, key };
}

/** Where a table's body ends: the next header line at depth 0, or the end of the text. */
function tableEnd(lines: readonly Line[], header: Line, textEnd: number): number {
  const next = lines.find((l) => l.start > header.start && l.depth === 0 && l.header !== undefined);
  return next?.start ?? textEnd;
}

function lineEnd(text: string, from: number): number {
  const nl = text.indexOf('\n', from);
  return nl === -1 ? text.length : nl;
}

function withTrailingNewline(text: string): string {
  return text === '' || text.endsWith('\n') ? text : `${text}\n`;
}

/** The index of the `]` closing the `[` at `open`, skipping strings and comments; -1 if none. */
function matchingBracket(text: string, open: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = open; i < text.length; ) {
    const ch = text[i] as string;
    if (quote !== undefined) {
      if (ch === '\\' && (quote === '"' || quote === '"""')) i += 2;
      else if (text.startsWith(quote, i)) {
        i += quote.length;
        quote = undefined;
      } else i += 1;
      continue;
    }
    if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      quote = text.slice(i, i + 3);
      i += 3;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
    } else if (ch === '#') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
    } else {
      if (ch === '[' || ch === '{') depth += 1;
      if (ch === ']' || ch === '}') {
        depth -= 1;
        if (depth === 0) return i;
      }
      i += 1;
    }
  }
  return -1;
}

/**
 * Insert `item` as the array's last element, in its style: on its own line
 * (with the array's indent) when the array spans lines, inline otherwise.
 */
function insertIntoArray(text: string, open: number, close: number, item: string): string {
  const inner = text.slice(open + 1, close);
  const last = lastValueEnd(text, open, close);
  if (last === undefined) return `${text.slice(0, open + 1)}${item}${text.slice(close)}`;
  const needsComma = text[last - 1] !== ',';
  if (!inner.includes('\n')) {
    return `${text.slice(0, last)}${needsComma ? ', ' : ' '}${item}${text.slice(last)}`;
  }
  const indent = /\n([ \t]*)\S/.exec(inner)?.[1] ?? '    ';
  return `${text.slice(0, last)}${needsComma ? ',' : ''}\n${indent}${item},${text.slice(last)}`;
}

/** The offset just after the array's last value (or its trailing comma), skipping comments; `undefined` when empty. */
function lastValueEnd(text: string, open: number, close: number): number | undefined {
  let lastEnd: number | undefined;
  let quote: string | undefined;
  for (let i = open + 1; i < close; ) {
    const ch = text[i] as string;
    if (quote !== undefined) {
      if (ch === '\\' && (quote === '"' || quote === '"""')) i += 2;
      else if (text.startsWith(quote, i)) {
        i += quote.length;
        quote = undefined;
        lastEnd = i;
      } else i += 1;
      continue;
    }
    if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      quote = text.slice(i, i + 3);
      i += 3;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
    } else if (ch === '#') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 || nl > close ? close : nl;
    } else if (/\s/.test(ch)) {
      i += 1;
    } else {
      i += 1;
      lastEnd = i;
    }
  }
  return lastEnd;
}
