// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Structured, lossless dotenv parser.
 *
 * **Grammar = `dotenv`'s `parse()`** (verified against `dotenv@16.3.1`,
 * the version Next.js 16 bundles, by `tests/conformance.test.ts`). An
 * application Kindgi is embedded in reads its `.env` files with that
 * parser; Kindgi reading the same file must see the same values.
 *
 *   - `KEY=value` or `KEY: value` (colon + at least one space).
 *     Optional leading whitespace and an optional `export ` prefix.
 *   - Keys: `[A-Za-z0-9_.-]+` (dotenv accepts lowercase, dots, dashes).
 *   - Unquoted values end at the first `#` (inline comment) and are
 *     trimmed.
 *   - `'…'`, `"…"` and `` `…` `` values may span lines. The closing
 *     quote must be followed only by whitespace or a `# comment` on its
 *     line; otherwise the value is read unquoted. Inside double quotes
 *     `\n` / `\r` become newline / carriage return; nothing else is
 *     unescaped (`\"` stays `\"`, exactly as dotenv does).
 *   - Duplicate keys: the last one wins.
 *   - Anything else is ignored by dotenv; here it surfaces as a
 *     `malformed` line so hand-edited files round-trip untouched.
 *
 * Deliberate divergence (pathological inputs only): dotenv's regex lets
 * a key's separator or an empty value's leading whitespace run across
 * a newline (`KEY=` followed by a line that starts with a quote joins
 * the two). Here a key, its separator, and the start of its value are
 * always on one line.
 *
 * Variable expansion (`${VAR}`) is a separate step — see `expand.ts`.
 * `parseEnvFile` returns values exactly as written.
 */

export interface EnvLine {
  readonly kind: 'blank' | 'comment' | 'entry' | 'malformed';
  /**
   * The line's source text. For an `entry` whose quoted value spans
   * several lines, `raw` holds all of them joined with `\n`.
   */
  readonly raw: string;
  readonly key?: string;
  /** Parsed (unexpanded) value. */
  readonly value?: string;
  /** `true` when the entry was written with an `export ` prefix. */
  readonly exported?: boolean;
  readonly reason?: string;
}

/** Keys dotenv accepts when READING a file. */
export const DOTENV_KEY_REGEX = /^[\w.-]+$/;

/**
 * Keys Kindgi WRITES: POSIX-shell env-var shape. Stricter than
 * `DOTENV_KEY_REGEX` so every name Kindgi writes is also exportable
 * from a shell.
 */
export const ENV_KEY_REGEX = /^[A-Z_][A-Z0-9_]*$/;

const ENTRY_HEAD = /^\s*(export\s+)?([\w.-]+)(?:\s*=|:\s)\s*/;
const TRAILER = /^\s*(?:#.*)?$/;
const QUOTES = new Set(["'", '"', '`']);

/**
 * Split dotenv text into structured lines. `serializeEnvFile` of the
 * result reproduces the input (line endings normalised to `\n`, which
 * is also what dotenv does before parsing).
 */
export function parseEnvFile(raw: string): readonly EnvLine[] {
  if (raw === '') return [];
  const physical = raw.split(/\r\n?|\n/);
  const lines =
    physical.length > 0 && physical[physical.length - 1] === '' ? physical.slice(0, -1) : physical;
  const out: EnvLine[] = [];
  let i = 0;
  while (i < lines.length) {
    const { line, consumed } = parseAt(lines, i);
    out.push(line);
    i += consumed;
  }
  return out;
}

/**
 * Parse a single entry's source text (possibly multi-line). Returns
 * `undefined` unless the whole text is exactly one entry. Used by the
 * serializer to decide whether an entry's `raw` is still faithful to
 * its `key` / `value`.
 */
export function parseEntryRaw(raw: string): EnvLine | undefined {
  const lines = parseEnvFile(raw);
  if (lines.length !== 1) return undefined;
  const [only] = lines;
  return only?.kind === 'entry' ? only : undefined;
}

/** Flatten entries into a record (last duplicate wins). Values are unexpanded. */
export function envLinesToRecord(lines: readonly EnvLine[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    if (line.kind === 'entry' && line.key !== undefined && line.value !== undefined) {
      out[line.key] = line.value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

interface ParseStep {
  readonly line: EnvLine;
  readonly consumed: number;
}

function parseAt(lines: readonly string[], i: number): ParseStep {
  const first = lines[i] ?? '';
  if (first.trim() === '') return { line: { kind: 'blank', raw: first }, consumed: 1 };
  if (first.trimStart().startsWith('#')) {
    return { line: { kind: 'comment', raw: first }, consumed: 1 };
  }

  const head = ENTRY_HEAD.exec(first);
  if (head === null) {
    return {
      line: { kind: 'malformed', raw: first, reason: 'not a `KEY=value` line' },
      consumed: 1,
    };
  }
  const key = head[2] ?? '';
  const exported = head[1] !== undefined;
  const valueStart = head[0].length;
  const opener = first[valueStart];

  if (opener !== undefined && QUOTES.has(opener)) {
    const quoted = scanQuoted(lines, i, valueStart, opener);
    if (quoted !== undefined) {
      const raw = lines.slice(i, i + quoted.lineCount).join('\n');
      return {
        line: entry(raw, key, unescapeQuoted(quoted.inner, opener), exported),
        consumed: quoted.lineCount,
      };
    }
  }

  return { line: entry(first, key, unquotedValue(first.slice(valueStart)), exported), consumed: 1 };
}

function entry(raw: string, key: string, value: string, exported: boolean): EnvLine {
  return exported
    ? { kind: 'entry', raw, key, value, exported: true }
    : { kind: 'entry', raw, key, value };
}

/**
 * Unquoted value: everything up to the first `#`, trimmed. dotenv then
 * strips one pair of matching outer quotes from the trimmed text (e.g.
 * `KEY="a" "b"` → `a" "b`), and expands `\n` / `\r` if that pair was
 * double quotes. Replicated exactly.
 */
function unquotedValue(rest: string): string {
  const hash = rest.indexOf('#');
  const v = (hash === -1 ? rest : rest.slice(0, hash)).trim();
  const q = v[0];
  if (v.length >= 2 && q !== undefined && QUOTES.has(q) && v[v.length - 1] === q) {
    return unescapeQuoted(v.slice(1, -1), q);
  }
  return v;
}

function unescapeQuoted(inner: string, quote: string): string {
  return quote === '"' ? inner.replace(/\\n/g, '\n').replace(/\\r/g, '\r') : inner;
}

interface QuotedScan {
  readonly inner: string;
  readonly lineCount: number;
}

interface Position {
  readonly line: number;
  readonly col: number;
}

/**
 * Closing-quote candidates in the order dotenv's regex tries them: the
 * first quote not preceded by a backslash, then each backslash-escaped
 * quote before it, last to first.
 */
function closingCandidates(
  lines: readonly string[],
  startLine: number,
  startCol: number,
  quote: string,
): Position[] {
  const escaped: Position[] = [];
  for (let line = startLine; line < lines.length; line += 1) {
    const text = lines[line] ?? '';
    const found = scanLine(text, line === startLine ? startCol + 1 : 0, quote);
    for (const col of found.escaped) escaped.push({ line, col });
    if (found.closing !== -1) return [{ line, col: found.closing }, ...escaped.reverse()];
  }
  return escaped.reverse();
}

/** One line's escaped-quote columns, and the first unescaped quote (-1 if none). */
function scanLine(
  text: string,
  from: number,
  quote: string,
): { readonly escaped: readonly number[]; readonly closing: number } {
  const escaped: number[] = [];
  let col = from;
  while (col < text.length) {
    if (text[col] === '\\' && text[col + 1] === quote) {
      escaped.push(col + 1);
      col += 2;
    } else if (text[col] === quote) {
      return { escaped, closing: col };
    } else {
      col += 1;
    }
  }
  return { escaped, closing: -1 };
}

/**
 * Find the closing quote the way dotenv's `'(?:\\'|[^'])*'` alternative
 * does (per quote character): the first quote not preceded by a
 * backslash is tried first; then, backtracking, each backslash-escaped
 * quote before it, last to first. A candidate is accepted when the rest
 * of its line is whitespace or a `# comment`. `undefined` = no candidate
 * works and the value is read unquoted.
 */
function scanQuoted(
  lines: readonly string[],
  startLine: number,
  startCol: number,
  quote: string,
): QuotedScan | undefined {
  for (const c of closingCandidates(lines, startLine, startCol, quote)) {
    const closingLine = lines[c.line] ?? '';
    if (!TRAILER.test(closingLine.slice(c.col + 1))) continue;
    return {
      inner: sliceAcross(lines, startLine, startCol + 1, c.line, c.col),
      lineCount: c.line - startLine + 1,
    };
  }
  return undefined;
}

function sliceAcross(
  lines: readonly string[],
  fromLine: number,
  fromCol: number,
  toLine: number,
  toCol: number,
): string {
  if (fromLine === toLine) return (lines[fromLine] ?? '').slice(fromCol, toCol);
  const parts = [(lines[fromLine] ?? '').slice(fromCol)];
  for (let li = fromLine + 1; li < toLine; li += 1) parts.push(lines[li] ?? '');
  parts.push((lines[toLine] ?? '').slice(0, toCol));
  return parts.join('\n');
}
