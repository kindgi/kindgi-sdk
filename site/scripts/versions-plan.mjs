// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Which docs the public site builds, from the `@kindgi/sdk@*` tags that
 * contain the site (`build-versions.mjs` reads the tags; this decides):
 *
 *   - every release, newest first (`releases`), each under `/vX.Y.Z/`, and
 *     each release line from its newest release tag, newest line first
 *     (`lines`): `/` is the newest line's, and `/vX.Y/` goes to its line's
 *     newest release. A pre-release (`0.1.4-rc.0`) never builds `/` or a
 *     release path: readers of the public site install releases;
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
 * @returns {{ releases: { tag: string, parsed: object }[], lines: { tag: string, parsed: object }[], next: { tag: string, parsed: object } | undefined }}
 */
export function plan(tags) {
  const newestPerLine = new Map();
  const releases = [];
  let next;
  for (const tag of tags) {
    const parsed = parse(tag.slice('@kindgi/sdk@'.length));
    if (!parsed) continue;
    if (parsed.pre !== undefined) {
      if (!next || compare(parsed, next.parsed) > 0) next = { tag, parsed };
      continue;
    }
    releases.push({ tag, parsed });
    const current = newestPerLine.get(parsed.line);
    if (!current || compare(parsed, current.parsed) > 0)
      newestPerLine.set(parsed.line, { tag, parsed });
  }
  releases.sort((a, b) => compare(b.parsed, a.parsed));
  const lines = [...newestPerLine.values()].sort((a, b) => compare(b.parsed, a.parsed));
  if (next && lines.length > 0 && compare(next.parsed, lines[0].parsed) < 0) next = undefined;
  return { releases, lines, next };
}

/**
 * `/versions.json`, what the version menu and the banner read: the root
 * (the newest release), every release under its own path (`/v0.1.2/`), and
 * the pre-release under `/next/`, each with the exact version it's built from
 * (`0.1.3`, `0.1.4-rc.3`) and its line (`0.1`). `latest` is the newest
 * release, exactly. Every version's pages read this one file, the ones built
 * from older tags too: their menu labels `v${version}`, and their banner
 * shows on any version other than `latest`.
 *
 * @param {ReturnType<typeof plan>} p
 */
export function menu({ releases, next }) {
  const entry = ({ parsed }) => ({ version: parsed.version, line: parsed.line });
  const versions = [];
  if (releases.length > 0) versions.push({ ...entry(releases[0]), path: '/' });
  for (const release of releases)
    versions.push({ ...entry(release), path: `/v${release.parsed.version}/` });
  if (next) versions.push({ ...entry(next), path: '/next/', next: true });
  return { latest: releases[0]?.parsed.version, versions };
}

/**
 * `/_redirects`: each release line's path (`/v0.1/`, the path before every
 * release had its own) goes to that line's newest release, page for page.
 *
 * @param {ReturnType<typeof plan>} p
 */
export function redirects({ lines }) {
  return lines
    .map(
      ({ parsed: { line, version } }) =>
        `/v${line} /v${version}/ 301\n/v${line}/* /v${version}/:splat 301\n`,
    )
    .join('');
}

/**
 * `/_headers`: every page's Markdown (`/start/install.md`, at the root and
 * under every version) is served with `X-Robots-Tag: noindex`, so search
 * engines list the pages, not their Markdown.
 *
 * The rules, as Cloudflare documents them for Workers static assets
 * (https://developers.cloudflare.com/workers/static-assets/headers/, the
 * same as Pages' `_headers`): a URL pattern on one line, its `Name: value`
 * headers indented below it. "A splat pattern — signified by an asterisk
 * (`*`) — will greedily match all characters. You may only include a single
 * splat in the URL", and the page's own example matches `/*.jpg`. So the one
 * rule `/*.md` matches `/index.md` and `/v0.1.7/start/install.md` alike,
 * well within the file's limit of 100 rules.
 */
export function headers() {
  return '/*.md\n  X-Robots-Tag: noindex\n';
}

/** The workspace's lockfile: a release's docs branch may change its `site` importer. */
export const LOCKFILE = 'pnpm-lock.yaml';
const SITE_IMPORTER = 'site';

/**
 * Each importer in a pnpm lockfile, by its path (`.`, `packages/api`,
 * `site`), with its block of the `importers:` section exactly as written.
 * The lockfile is YAML, and the site has no YAML library: the guard only
 * compares blocks, so this splits the section at its two-space-indented
 * keys, and a line at the left margin (the next top-level key, or a new
 * document's `---`) ends it. pnpm can write more than one document (its
 * own version and config dependencies in one before the main one), each
 * with its own `importers:`: an importer in several keeps each document's
 * block, in order.
 *
 * @param {string} text the lockfile
 * @returns {Map<string, string>}
 */
export function lockfileImporters(text) {
  const blocks = new Map();
  let inImporters = false;
  let block;
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) {
      inImporters = line === 'importers:';
      block = undefined;
      continue;
    }
    if (!inImporters) continue;
    const key = /^ {2}(\S.*):$/.exec(line);
    if (key) {
      const name = key[1].replace(/^'(.*)'$/, (_, quoted) => quoted.replaceAll("''", "'"));
      block = [];
      blocks.set(name, [...(blocks.get(name) ?? []), block]);
    }
    block?.push(line);
  }
  return new Map(
    [...blocks].map(([name, list]) => [
      name,
      list.map((lines) => lines.join('\n').trimEnd()).join('\n---\n'),
    ]),
  );
}

/** An importer's name in a message: the workspace root's is `.`. */
const importerName = (name) => (name === '.' ? '. (the workspace root)' : name);

/**
 * Which git ref a release's docs build from (the pre-release on `/next/`
 * too). A release's docs are fixed after it ships on its
 * `release-docs/<version>` branch (reviewed through a PR, as every docs
 * change is): the branch starts at the release's tag and changes
 * only `site/`, so the release's pages are fixed while its code and its
 * generated reference stay the tag's. Without the branch, the tag. A branch
 * that doesn't start at the tag, or that changes anything outside `site/`,
 * fails the build: it would put under the release's docs code the release
 * doesn't have.
 *
 * The one exception is `pnpm-lock.yaml`, so a fix can bring a dependency of
 * the site's own, behind the site-only lockfile guard: every importer but
 * `site` must be the same at the branch as at the tag, else the build fails
 * naming the importers that differ.
 *
 * @param {{ tag: string, branch?: string, startsAtTag?: boolean, changed?: readonly string[], lockfiles?: { tag: string, branch: string } }} source
 *   `branch`: the release's docs branch, if there is one; `startsAtTag`: the
 *   tag is an ancestor of the branch; `changed`: the files the branch changes
 *   since the tag; `lockfiles`: `pnpm-lock.yaml` at the tag and at the branch,
 *   when the branch changes it.
 * @returns {{ ref: string } | { error: string }}
 */
export function docsSource({ tag, branch, startsAtTag = false, changed = [], lockfiles }) {
  if (branch === undefined) return { ref: tag };
  if (!startsAtTag) {
    return {
      error: `${branch} doesn't start at ${tag}: a release's docs branch starts at its tag.`,
    };
  }
  const outside = changed.filter((file) => !file.startsWith('site/') && file !== LOCKFILE);
  if (outside.length > 0) {
    return {
      error: `${branch} changes files outside site/ since ${tag} (${outside.join(', ')}): a release's docs branch may change only its docs, and ${LOCKFILE} for the site's dependencies.`,
    };
  }
  if (changed.includes(LOCKFILE)) {
    // The site-only lockfile guard: the branch may change the site's
    // dependencies, and nothing the release's code installs.
    const guard = 'the site-only lockfile guard';
    if (lockfiles === undefined) {
      return {
        error: `${branch} changes ${LOCKFILE} since ${tag}, and ${guard} needs the lockfile at both to check it.`,
      };
    }
    const before = lockfileImporters(lockfiles.tag);
    const after = lockfileImporters(lockfiles.branch);
    if (before.size === 0 || after.size === 0) {
      return {
        error: `${guard} finds no importers in ${LOCKFILE} at ${before.size === 0 ? tag : branch}: it can't check what ${branch} changes.`,
      };
    }
    const names = new Set([...before.keys(), ...after.keys()]);
    names.delete(SITE_IMPORTER);
    const differ = [...names].filter((name) => before.get(name) !== after.get(name));
    if (differ.length > 0) {
      return {
        error: `${branch} changes ${LOCKFILE} outside the site importer since ${tag} (${differ.map(importerName).join(', ')}): ${guard} lets a release's docs branch change only the site's dependencies.`,
      };
    }
  }
  return { ref: branch };
}
