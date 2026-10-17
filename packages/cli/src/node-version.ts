// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// The Node the CLI runs on. `cli.ts` checks it before the rest of the CLI
// loads, so this module imports nothing: on an older Node, loading the rest
// warns or fails first, and the one line saying what to do never shows. For
// the same reason it keeps to syntax older Nodes parse (no nullish
// coalescing or optional chaining, which Node 12 can't).

/** The Node the CLI needs (`engines.node` in its package.json). */
export const MIN_NODE = '22.12.0';

/** {@link MIN_NODE}'s major, as `nvm install` takes it. */
export const MIN_NODE_MAJOR = MIN_NODE.split('.')[0];

/** `a` ≥ `b`, comparing `major.minor.patch`. */
export function atLeast(a: string, b: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split(/[.-]/)
      .slice(0, 3)
      .map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

/**
 * The line `kindgi` stops with on a Node older than {@link MIN_NODE}
 * (`version` as `process.versions.node` gives it, `20.11.0`); `undefined`
 * on a Node it runs on.
 */
export function unsupportedNode(version: string): string | undefined {
  if (atLeast(version, MIN_NODE)) return undefined;
  return `Kindgi needs Node ${MIN_NODE} or later; this is Node ${version}. Install or switch to it (nvm install ${MIN_NODE_MAJOR}, or https://nodejs.org), then run the command again.`;
}
