// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Whether a release version (`0.12.15`) satisfies a PEP 440 specifier set
 * (`>=0.12.15,<0.13`) — enough for uv's `required-version`: release
 * versions, the comparison operators, `~=`, and `==` / `!=` with `.*`.
 * `undefined` when the set uses something this doesn't read, so callers
 * can stay out of the way rather than refuse a valid range.
 */

type Release = readonly number[];

export function satisfiesSpecifiers(version: string, specifiers: string): boolean | undefined {
  const v = parseRelease(version);
  if (v === undefined) return undefined;
  const clauses = specifiers
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c !== '');
  if (clauses.length === 0) return undefined;
  let all = true;
  for (const clause of clauses) {
    const ok = satisfies(v, clause);
    if (ok === undefined) return undefined;
    all &&= ok;
  }
  return all;
}

function satisfies(v: Release, clause: string): boolean | undefined {
  const m = /^(~=|===|==|!=|<=|>=|<|>)\s*([0-9]+(?:\.[0-9]+)*)(\.\*)?$/.exec(clause);
  if (m === null) return undefined;
  const [, op, raw, wildcard] = m as unknown as [string, string, string, string | undefined];
  const target = parseRelease(raw) as Release;
  if (wildcard !== undefined) {
    if (op !== '==' && op !== '!=') return undefined;
    const prefix = startsWith(v, target);
    return op === '==' ? prefix : !prefix;
  }
  const c = compare(v, target);
  switch (op) {
    case '==':
    case '===':
      return c === 0;
    case '!=':
      return c !== 0;
    case '<':
      return c < 0;
    case '<=':
      return c <= 0;
    case '>':
      return c > 0;
    case '>=':
      return c >= 0;
    default:
      // `~=X.Y.Z` is `>=X.Y.Z, ==X.Y.*`; it needs two release segments.
      if (target.length < 2) return undefined;
      return c >= 0 && startsWith(v, target.slice(0, -1));
  }
}

function parseRelease(text: string): Release | undefined {
  return /^[0-9]+(\.[0-9]+)*$/.test(text) ? text.split('.').map(Number) : undefined;
}

function compare(a: Release, b: Release): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function startsWith(v: Release, prefix: Release): boolean {
  return prefix.every((part, i) => (v[i] ?? 0) === part);
}
