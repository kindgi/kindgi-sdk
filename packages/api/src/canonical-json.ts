// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** JSON with every object's keys sorted, and absent and `undefined` alike. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(JSON.parse(JSON.stringify(value) ?? 'null'), (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : v,
  );
}

/** Whether two values are the same JSON, key order aside. */
export function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
