// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Which docs the public site builds, from the `@kindgi/sdk@*` tags that
 * contain the site (`build-versions.mjs` reads the tags; this decides):
 *
 *   - each release line from its newest release tag, newest line first. A
 *     pre-release (`0.1.4-rc.0`) never builds `/` or `/vX.Y/`: readers of the
 *     public site install releases;
 *   - `next`: the newest pre-release newer than every release, if there is
 *     one, for `/next/`. Once its release ships, it's older than the release,
 *     and `/next/` goes away until the next pre-release.
 */

/** `X.Y.Z[-pre]` → comparable parts; prereleases sort before their release. */
export function parse(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(version);
  if (!m) return undefined;
  return { version, line: `${m[1]}.${m[2]}`, nums: [+m[1], +m[2], +m[3]], pre: m[4] };
}

export function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] - b.nums[i];
  if (a.pre === b.pre) return 0;
  if (a.pre === undefined) return 1;
  if (b.pre === undefined) return -1;
  return a.pre.localeCompare(b.pre, undefined, { numeric: true });
}

/**
 * @param {readonly string[]} tags `@kindgi/sdk@X.Y.Z[-pre]` tags that contain the site
 * @returns {{ lines: { tag: string, parsed: object }[], next: { tag: string, parsed: object } | undefined }}
 */
export function plan(tags) {
  const releases = new Map();
  let next;
  for (const tag of tags) {
    const parsed = parse(tag.slice('@kindgi/sdk@'.length));
    if (!parsed) continue;
    if (parsed.pre !== undefined) {
      if (!next || compare(parsed, next.parsed) > 0) next = { tag, parsed };
      continue;
    }
    const current = releases.get(parsed.line);
    if (!current || compare(parsed, current.parsed) > 0) releases.set(parsed.line, { tag, parsed });
  }
  const lines = [...releases.values()].sort((a, b) => compare(b.parsed, a.parsed));
  if (next && lines.length > 0 && compare(next.parsed, lines[0].parsed) < 0) next = undefined;
  return { lines, next };
}
