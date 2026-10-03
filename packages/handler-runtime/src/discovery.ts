// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Discovery-glob primitives shared by the indexer and anything that
 * watches a pack (a dev watch loop) — so "which files are primitives"
 * has one answer.
 *
 * Supported syntax: `**` (any depth, including none), `*` (within one
 * segment), `?` (one character), `{a,b,c}` alternation. Negations and
 * extglobs are not supported.
 *
 * Every pattern has a **static prefix** — the directory segments before
 * the first wildcard (`kindgi/tools/**\/*.ts` → `kindgi/tools`). Walking
 * or watching only that prefix matters when a pack lives inside a large
 * application: the indexer must not crawl the whole host repo to find
 * `kindgi/**`.
 */

const GLOB_CHARS = /[*?{[]/;

/** Test / spec files sit next to primitives and are never primitives. */
export const TEST_FILE_REGEX = /\.(test|spec)\.(ts|js|mjs|cjs)$/;

/** Compile a discovery pattern to an anchored RegExp over `/`-separated relative paths. */
export function globToRegex(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const [piece, next] = globToken(pattern, i);
    re += piece;
    i = next;
  }
  return new RegExp(`^${re}$`);
}

/** The regex source for the token at `i`, and the index after it. */
function globToken(pattern: string, i: number): readonly [string, number] {
  const c = pattern.charAt(i);
  if (c === '*' && pattern.charAt(i + 1) === '*') {
    // `**/` may match zero segments; a trailing `**` matches anything.
    return pattern.charAt(i + 2) === '/' ? ['(?:.*/)?', i + 3] : ['.*', i + 2];
  }
  if (c === '*') return ['[^/]*', i + 1];
  if (c === '?') return ['[^/]', i + 1];
  const close = c === '{' ? pattern.indexOf('}', i) : -1;
  if (close !== -1) {
    const options = pattern
      .slice(i + 1, close)
      .split(',')
      .map(escapeRegex);
    return [`(?:${options.join('|')})`, close + 1];
  }
  return [escapeRegex(c), i + 1];
}

function escapeRegex(s: string): string {
  return s.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
}

/**
 * Directory prefix before the first wildcard segment, `''` for the pack
 * root. A pattern without wildcards names a file; its prefix is that
 * file's directory.
 */
export function globStaticPrefix(pattern: string): string {
  const segments = pattern.split('/');
  const firstGlob = segments.findIndex((s) => GLOB_CHARS.test(s));
  const dirSegments = firstGlob === -1 ? segments.slice(0, -1) : segments.slice(0, firstGlob);
  return dirSegments.filter((s) => s !== '' && s !== '.').join('/');
}

/**
 * The directories to walk or watch for a set of patterns: each pattern's
 * static prefix, with any prefix inside another one dropped. `['']`
 * means the pack root.
 */
export function discoveryRoots(patterns: readonly string[]): readonly string[] {
  const prefixes = [...new Set(patterns.map(globStaticPrefix))].sort();
  return prefixes.filter(
    (p) => !prefixes.some((other) => other !== p && (other === '' || p.startsWith(`${other}/`))),
  );
}

/** `(relPath) => true` when the path matches any pattern and is not a test file. */
export function createGlobMatcher(patterns: readonly string[]): (relPath: string) => boolean {
  const regexes = patterns.map(globToRegex);
  return (relPath) => !TEST_FILE_REGEX.test(relPath) && regexes.some((r) => r.test(relPath));
}
