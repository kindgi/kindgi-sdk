// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `${VAR}` expansion over parsed dotenv values.
 *
 * Host frameworks expand with `dotenv-expand`, but not one version:
 * Next.js 16 bundles v10's algorithm, Vite uses v12, and the two differ
 * (v10 resolves references to keys defined later in the file, v12
 * does not). This module implements one well-defined semantics that
 * agrees with BOTH on everything they agree on — verified by
 * `tests/conformance.test.ts` — and picks Next.js's (order-independent)
 * answer where they differ.
 *
 * Syntax:
 *   - `$NAME` (`[A-Za-z_][A-Za-z0-9_]*`) and `${NAME}`
 *   - `${NAME:-default}` — default when NAME is unset or empty
 *   - `${NAME-default}`  — default when NAME is unset
 *   - `${NAME:+alt}`     — alt when NAME is set and non-empty, else empty
 *   - `${NAME+alt}`      — alt when NAME is set, else empty
 *   - `\$` — a literal `$` (the writer escapes every `$` this way)
 *   Defaults / alts are themselves expanded. A `$` not followed by a
 *   name or `{…}` is literal.
 *
 * Lookup: a name defined in the files resolves to its (expanded) file
 * value, wherever in the files it is defined. Only a name defined in no
 * file falls back to `options.env` (so `${HOME}` works). Unlike
 * `dotenv-expand`, the caller's env never overrides a file's own value:
 * the files are the source, the environment only fills gaps. Nothing
 * reads `process.env` implicitly — callers pass what they mean.
 *
 * Undefined references expand to `''` and cycles (`A=$B`, `B=$A`) are
 * cut at the repeated name; both are reported in `diagnostics`.
 */

export interface ExpandOptions {
  /** Fallback for names no file defines. Never overrides a file value. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ExpandDiagnostic {
  readonly kind: 'unresolved' | 'cycle';
  /** The key whose value contains the reference. */
  readonly key: string;
  /** The referenced name. */
  readonly ref: string;
}

export interface ExpandResult {
  readonly values: Record<string, string>;
  readonly diagnostics: readonly ExpandDiagnostic[];
}

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const OPERATORS = [':-', ':+', '-', '+'] as const;
type Operator = (typeof OPERATORS)[number];

export function expandEnv(
  values: Readonly<Record<string, string>>,
  options: ExpandOptions = {},
): ExpandResult {
  const env = options.env ?? {};
  const resolved = new Map<string, string>();
  const stack: string[] = [];
  const diagnostics: ExpandDiagnostic[] = [];
  const has = (name: string): boolean => Object.prototype.hasOwnProperty.call(values, name);

  function lookup(name: string, fromKey: string): string | undefined {
    if (has(name)) {
      if (stack.includes(name)) {
        diagnostics.push({ kind: 'cycle', key: fromKey, ref: name });
        return undefined;
      }
      return resolve(name);
    }
    const fromEnv = env[name];
    return typeof fromEnv === 'string' ? fromEnv : undefined;
  }

  function resolve(key: string): string {
    const cached = resolved.get(key);
    if (cached !== undefined) return cached;
    stack.push(key);
    const out = expandString(values[key] ?? '', key);
    stack.pop();
    resolved.set(key, out);
    return out;
  }

  function evaluate(expression: string, key: string): string {
    const { name, op, operand } = splitExpression(expression);
    const value = lookup(name, key);
    if (op !== undefined) return APPLY[op](value, () => expandString(operand, key));
    if (value !== undefined) return value;
    if (!diagnostics.some((d) => d.key === key && d.ref === name)) {
      diagnostics.push({ kind: 'unresolved', key, ref: name });
    }
    return '';
  }

  function expandString(input: string, key: string): string {
    let out = '';
    let i = 0;
    while (i < input.length) {
      const token = readToken(input, i);
      if (token === undefined) {
        out += input[i];
        i += 1;
        continue;
      }
      out += token.kind === 'escape' ? '$' : evaluate(token.expression, key);
      i = token.end;
    }
    return out;
  }

  const out: Record<string, string> = {};
  for (const key of Object.keys(values)) out[key] = resolve(key);
  return { values: out, diagnostics };
}

/** Operator semantics (bash): `:` also treats an empty value as unset. */
const APPLY: Readonly<
  Record<Operator, (value: string | undefined, operand: () => string) => string>
> = {
  ':-': (value, operand) => (value === undefined || value === '' ? operand() : value),
  '-': (value, operand) => (value === undefined ? operand() : value),
  ':+': (value, operand) => (value !== undefined && value !== '' ? operand() : ''),
  '+': (value, operand) => (value !== undefined ? operand() : ''),
};

type Token =
  | { readonly kind: 'escape'; readonly end: number }
  | { readonly kind: 'ref'; readonly expression: string; readonly end: number };

/** The escape or reference starting at `i`, if any. */
function readToken(input: string, i: number): Token | undefined {
  if (input[i] === '\\' && input[i + 1] === '$') return { kind: 'escape', end: i + 2 };
  if (input[i] !== '$') return undefined;
  const next = input[i + 1];
  if (next === '{') {
    const close = findBraceClose(input, i + 2);
    return close === -1
      ? undefined
      : { kind: 'ref', expression: input.slice(i + 2, close), end: close + 1 };
  }
  if (next === undefined || !NAME_START.test(next)) return undefined;
  let end = i + 2;
  while (end < input.length && NAME_CHAR.test(input[end] ?? '')) end += 1;
  return { kind: 'ref', expression: input.slice(i + 1, end), end };
}

/**
 * Index of the `}` closing a `${…}` whose body starts at `from`, or -1
 * when it is not an expression (empty body, unterminated, or a bare `{`
 * inside). A nested `${…}` — e.g. in a default — nests; `\$` is skipped.
 */
function findBraceClose(input: string, from: number): number {
  const tokens = /\\\$|\$\{|[{}]/g;
  tokens.lastIndex = from;
  let depth = 1;
  for (let m = tokens.exec(input); m !== null; m = tokens.exec(input)) {
    if (m[0] === '{') return -1;
    if (m[0] === '${') depth += 1;
    else if (m[0] === '}') depth -= 1;
    if (depth === 0) return m.index === from ? -1 : m.index;
  }
  return -1;
}

function splitExpression(expression: string): {
  readonly name: string;
  readonly op: Operator | undefined;
  readonly operand: string;
} {
  for (let i = 1; i < expression.length; i += 1) {
    for (const op of OPERATORS) {
      if (expression.startsWith(op, i)) {
        return { name: expression.slice(0, i), op, operand: expression.slice(i + op.length) };
      }
    }
  }
  return { name: expression, op: undefined, operand: '' };
}
