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
 * The Markdown and the `llms*.txt` files say they're UTF-8, whichever
 * Wrangler uploads them: a deploy has served `llms.txt` as `text/plain` with
 * no charset, and a browser or HTTP client that assumes another encoding
 * shows `…` as `â€¦`. A `Content-Type` here replaces the one the file's
 * extension gives it, not adds to it (checked under `wrangler dev` 4.149).
 *
 * The rules, as Cloudflare documents them for Workers static assets
 * (https://developers.cloudflare.com/workers/static-assets/headers/, the
 * same as Pages' `_headers`): a URL pattern on one line, its `Name: value`
 * headers indented below it. "A splat pattern — signified by an asterisk
 * (`*`) — will greedily match all characters. You may only include a single
 * splat in the URL", and the page's own example matches `/*.jpg`. So
 * `/*.md` matches `/index.md` and `/v0.1.7/start/install.md` alike, and
 * `/*.txt` every `llms*.txt` file and `_llms-txt/`'s, at the root and under
 * every version: two rules, well within the file's limit of 100.
 */
export function headers() {
  return [
    '/*.md',
    '  Content-Type: text/markdown; charset=utf-8',
    '  X-Robots-Tag: noindex',
    '/*.txt',
    '  Content-Type: text/plain; charset=utf-8',
    '',
  ].join('\n');
}

/**
 * `/robots.txt`: nothing is disallowed, and it names the sitemap of `/`, the
 * newest release and the only build search engines list. The other builds
 * (`/vX.Y.Z/`, `/next/`) say `noindex` in their pages, which a crawler reads
 * only when it may fetch them: a `Disallow` for them would leave their
 * addresses listable instead.
 *
 * The sitemap is the one `/`'s own `sitemap-index.xml` (Starlight's, from
 * `site`) is on, so robots.txt can't name one the build didn't make. When
 * the zone has Cloudflare's managed robots.txt on, Cloudflare puts its own
 * lines before these.
 *
 * @param {string | undefined} sitemapIndex `/sitemap-index.xml`, as built
 */
export function robots(sitemapIndex) {
  const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/.exec(sitemapIndex ?? '')?.[1];
  if (loc === undefined) {
    throw new Error(
      'robots: / has no sitemap-index.xml naming a sitemap (Starlight makes one when astro.config.mjs sets `site`)',
    );
  }
  return `User-agent: *\nAllow: /\n\nSitemap: ${new URL('/sitemap-index.xml', loc).href}\n`;
}

/** The workspace's lockfile: a release's docs branch may change what only the site installs. */
export const LOCKFILE = 'pnpm-lock.yaml';
const SITE_IMPORTER = 'site';
/** The lockfile sections split into blocks by key; the rest is compared whole. */
const KEYED = ['importers', 'packages', 'snapshots'];

/** `key: value` (or `key:`) at exactly `indent` spaces, the key quoted or not. */
function keyLine(line, indent) {
  const match = new RegExp(
    `^ {${indent}}(?:'((?:[^']|'')*)'|"([^"]*)"|([^\\s'"#][^]*?)):(?: (.*))?$`,
  ).exec(line);
  if (!match) return undefined;
  return {
    key: match[1]?.replaceAll("''", "'") ?? match[2] ?? match[3],
    value: match[4] === undefined ? undefined : unquote(match[4]),
  };
}

/** A YAML scalar as written, without its quotes. */
function unquote(value) {
  const single = /^'(.*)'$/.exec(value);
  if (single) return single[1].replaceAll("''", "'");
  return /^"(.*)"$/.exec(value)?.[1] ?? value;
}

/**
 * A pnpm lockfile's documents, each as its `importers`, `packages` and
 * `snapshots` blocks by key (`site`, `foo@1.2.0`,
 * `bar@2.0.0(react@18.0.0)`), each block exactly as written, and `rest`:
 * its other lines (its version, settings, overrides). The lockfile is
 * YAML, and the site has no YAML library: the guard only compares blocks,
 * so this splits each section at its two-space-indented keys, and a line at
 * the left margin (the next top-level key) ends it. pnpm can write more
 * than one document, a `---` line before each: its own version and config
 * dependencies in one, then the workspace's.
 *
 * @param {string} text the lockfile
 * @returns {{ importers: Map<string, string>, packages: Map<string, string>, snapshots: Map<string, string>, rest: string }[]}
 */
export function lockfileDocuments(text) {
  return groupLines(['---', ...text.split('\n')], (line) => line === '---')
    .map(([, ...lines]) => lines)
    .filter((lines) => lines.some((line) => line.trim() !== ''))
    .map(lockfileDocument);
}

/** `lines` in groups, each from a line `starts` picks (lines before the first go in none). */
function groupLines(lines, starts) {
  const groups = [];
  for (const line of lines) {
    if (starts(line)) groups.push([line]);
    else groups.at(-1)?.push(line);
  }
  return groups;
}

/** One document of a lockfile: its keyed sections' blocks, and the rest. */
function lockfileDocument(lines) {
  const document = Object.fromEntries(KEYED.map((name) => [name, new Map()]));
  const rest = [];
  for (const [header, ...body] of groupLines(lines, (line) => /^\S/.test(line))) {
    const name = /^(\w+):$/.exec(header)?.[1];
    if (!KEYED.includes(name)) {
      rest.push(header, ...body.filter((line) => line.trim() !== ''));
      continue;
    }
    for (const block of groupLines(body, (line) => keyLine(line, 2) !== undefined)) {
      document[name].set(keyLine(block[0], 2).key, block.join('\n').trimEnd());
    }
  }
  return { ...document, rest: rest.join('\n') };
}

/**
 * The snapshot a dependency resolves to: `name@version`, its peers'
 * suffix included (`bar@2.0.0(react@18.0.0)`); an alias's version names
 * its package (`dotenv-expand@10.0.0`); a workspace package (`link:`) has
 * none.
 */
export function snapshotKey(name, version) {
  if (version.startsWith('link:')) return undefined;
  return version.split('(')[0].includes('@') ? version : `${name}@${version}`;
}

/** A snapshot's `packages:` entry: its key without the peers' suffix. */
const packageKey = (snapshot) => {
  const at = snapshot.indexOf('(');
  return at === -1 ? snapshot : snapshot.slice(0, at);
};

/**
 * The snapshots an importer's block names: each dependency's `version:`,
 * whatever its group (`dependencies`, `devDependencies`, pnpm's own).
 */
function importerSnapshots(block) {
  const keys = [];
  let name;
  for (const line of block.split('\n')) {
    const dependency = keyLine(line, 6);
    if (dependency) name = dependency.value === undefined ? dependency.key : undefined;
    const version = /^ {8}version: (.+)$/.exec(line);
    if (version && name !== undefined) keys.push(snapshotKey(name, unquote(version[1])));
  }
  return keys.filter((key) => key !== undefined);
}

/** The snapshots a snapshot's block names: its `dependencies` and `optionalDependencies`. */
function snapshotSnapshots(block) {
  const keys = [];
  let group;
  for (const line of block.split('\n')) {
    const header = keyLine(line, 4);
    if (header) group = header.key;
    const dependency = keyLine(line, 6);
    if (
      dependency?.value !== undefined &&
      (group === 'dependencies' || group === 'optionalDependencies')
    ) {
      keys.push(snapshotKey(dependency.key, dependency.value));
    }
  }
  return keys.filter((key) => key !== undefined);
}

/** Every snapshot a document's importers but `site` reach, transitively. */
function reachedOutsideSite(document) {
  const reached = new Set();
  const queue = [...document.importers]
    .filter(([name]) => name !== SITE_IMPORTER)
    .flatMap(([, block]) => importerSnapshots(block));
  for (let next = 0; next < queue.length; next += 1) {
    const key = queue[next];
    if (reached.has(key)) continue;
    reached.add(key);
    const block = document.snapshots.get(key);
    if (block !== undefined) queue.push(...snapshotSnapshots(block));
  }
  return reached;
}

/** An importer's name in a message: the workspace root's is `.`. */
const importerName = (name) => (name === '.' ? '. (the workspace root)' : name);

/** How many differing entries a message names; it counts them all. */
const NAMED = 5;

/**
 * What differs between one document of the tag's lockfile and the same
 * document of the branch's, outside what only `site` installs: the
 * importers but `site` whose blocks differ, and the other entries (the
 * top-level settings; each snapshot those importers reach, and its package).
 */
function documentDifferences(was, is, index) {
  const importers = [...new Set([...was.importers.keys(), ...is.importers.keys()])].filter(
    (name) => name !== SITE_IMPORTER && was.importers.get(name) !== is.importers.get(name),
  );
  const entries = was.rest === is.rest ? [] : [`its top-level settings (document ${index + 1})`];
  for (const key of new Set([...reachedOutsideSite(was), ...reachedOutsideSite(is)])) {
    if (was.snapshots.get(key) !== is.snapshots.get(key)) entries.push(`${key} (snapshot)`);
    const pkg = packageKey(key);
    if (was.packages.get(pkg) !== is.packages.get(pkg)) entries.push(`${pkg} (package)`);
  }
  return { importers, entries };
}

/**
 * The site-only lockfile guard: an error unless the branch's lockfile
 * installs, for every importer but `site`, exactly what the tag's does.
 * Checked, document by document: the same number of documents; the same
 * lines outside `importers`, `packages` and `snapshots` (the lockfile's
 * version, settings, overrides); every importer's block but `site`'s the
 * same; and every snapshot those importers reach, through `dependencies`
 * and `optionalDependencies` at any depth, the same, its `packages` entry
 * too. What only `site` reaches may change, come or go.
 */
function lockfileGuard({ tag, branch, lockfiles }) {
  const guard = 'the site-only lockfile guard';
  const refuse = (what) =>
    `${branch} changes ${what} since ${tag}: ${guard} lets a release's docs branch change only what the site alone installs.`;
  if (lockfiles === undefined) {
    return `${branch} changes ${LOCKFILE} since ${tag}, and ${guard} needs the lockfile at both to check it.`;
  }
  const before = lockfileDocuments(lockfiles.tag);
  const after = lockfileDocuments(lockfiles.branch);
  const unreadable = [
    [before, tag],
    [after, branch],
  ].find(([documents]) => documents.every((document) => document.importers.size === 0));
  if (unreadable) {
    return `${guard} finds no importers in ${LOCKFILE} at ${unreadable[1]}: it can't check what ${branch} changes.`;
  }
  if (before.length !== after.length) {
    return refuse(`the number of documents in ${LOCKFILE} (${before.length} to ${after.length})`);
  }
  const differences = before.map((was, index) => documentDifferences(was, after[index], index));
  const importers = [...new Set(differences.flatMap((d) => d.importers))];
  if (importers.length > 0) {
    return refuse(
      `${LOCKFILE} outside the site importer (${importers.map(importerName).join(', ')})`,
    );
  }
  const entries = differences.flatMap((d) => d.entries);
  if (entries.length > 0) {
    const more = entries.length > NAMED ? `, and ${entries.length - NAMED} more` : '';
    return refuse(
      `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} of ${LOCKFILE} that importers other than site install (${entries.slice(0, NAMED).join(', ')}${more})`,
    );
  }
  return undefined;
}

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
 * the site's own, behind the site-only lockfile guard (`lockfileGuard`):
 * the build installs and builds the whole workspace from the branch's
 * lockfile, so what every importer but `site` installs must be what it
 * installs at the tag, down to each transitive package. Else the build
 * fails, naming what differs.
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
    const error = lockfileGuard({ tag, branch, lockfiles });
    if (error !== undefined) return { error };
  }
  return { ref: branch };
}
