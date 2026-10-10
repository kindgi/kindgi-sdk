// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * Tutorials publish on their own schedule, not with a release. A tutorial
 * opts in with a pin in its frontmatter, `tested: 0.1.6`: the Kindgi release
 * it was tested with, and written for. The newest release's build (`/`) takes
 * every pinned tutorial from `main` whose pin is at or below that release, in
 * place of the release's own copy, and `/vX.Y.Z/` and `/next/` redirect their
 * copies of those pages to `/tutorials/…`.
 *
 * A tutorial without a pin stays the release's, like every other page: the
 * support-desk tutorials are, since CI runs them against the code they
 * describe. A pinned tutorial is built with the newest release's site, so it
 * may use only the components that site has: an import it can't resolve
 * stops the build, naming the page (see the site README's "Tutorials").
 */
import { posix } from 'node:path';
import { compare, parse } from './versions-plan.mjs';

/** Where the tutorials live, from the repository's root. */
export const TUTORIALS = 'site/src/content/docs/tutorials/';

const PAGE = /\.mdx?$/;

/**
 * The `tested:` pin in a page's frontmatter, or undefined when it has none.
 * A pin that isn't a release version (`X.Y.Z`, no pre-release) throws.
 *
 * @param {string} source the page's text
 * @param {string} file the page's path, for the error
 */
export function pinOf(source, file) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!frontmatter) return undefined;
  const line = /^tested:[ \t]*(.*?)[ \t]*$/m.exec(frontmatter[1]);
  if (!line) return undefined;
  const value = line[1].replace(/^(['"])(.*)\1$/, '$2');
  const parsed = parse(value);
  if (parsed === undefined || parsed.pre !== undefined) {
    throw new Error(`${file}: "tested: ${line[1]}" isn't a Kindgi release (X.Y.Z)`);
  }
  return parsed;
}

/** A page's path under `/tutorials/`: `woo.mdx` → `woo`, `woo/index.mdx` → `woo`, the section's index → ``. */
export function slugOf(path) {
  const bare = path.replace(PAGE, '');
  if (bare === 'index') return '';
  return bare.endsWith('/index') ? bare.slice(0, -'/index'.length) : bare;
}

/**
 * Which of `main`'s tutorial files the newest release's build takes.
 *
 * @param {readonly { path: string, source?: string }[]} files every file under
 *   the tutorials folder on `main`, its path relative to that folder, with the
 *   text of each page (`.md`, `.mdx`)
 * @param {{ version: string, nums: number[] }} root the newest release
 * @returns {{ take: string[], pages: string[], later: { path: string, pin: string }[] }}
 *   `take`: the files to copy; `pages`: the pinned pages' slugs, for the
 *   redirects; `later`: pinned pages waiting for a newer release
 */
export function pinnedTutorials(files, root) {
  const take = new Set();
  const pages = [];
  const later = [];
  for (const { path, source } of files) {
    if (!PAGE.test(path) || source === undefined) continue;
    const pin = pinOf(source, `${TUTORIALS}${path}`);
    if (pin === undefined) continue;
    if (compare(pin, root) > 0) {
      later.push({ path, pin: pin.version });
      continue;
    }
    pages.push(slugOf(path));
    take.add(path);
    // A page that's its folder's index brings the folder: its pictures.
    if (/(^|\/)index\.mdx?$/.test(path) && path.includes('/')) {
      const folder = path.slice(0, path.lastIndexOf('/') + 1);
      for (const other of files) if (other.path.startsWith(folder)) take.add(other.path);
    }
  }
  return { take: [...take].sort(), pages: pages.sort(), later };
}

/**
 * The imports in a pinned MDX page that the newest release's site can't
 * resolve: a relative or `~/` path that isn't there, or a package it
 * doesn't have. A `.md` page imports nothing.
 *
 * @param {string} source the page's text
 * @param {string} file the page's path from the repository's root
 * @param {(pathFromRepoRoot: string) => boolean} exists
 * @returns {string[]} the specifiers that don't resolve
 */
export function missingImports(source, file, exists) {
  if (!file.endsWith('.mdx')) return [];
  const missing = [];
  for (const [, specifier] of source.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
    let target;
    if (specifier.startsWith('.'))
      target = posix.normalize(posix.join(posix.dirname(file), specifier));
    else if (specifier.startsWith('~/')) target = `site/src/${specifier.slice(2)}`;
    else {
      const parts = specifier.split('/');
      const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
      target = `site/node_modules/${name}`;
    }
    if (!exists(target)) missing.push(specifier);
  }
  return missing;
}

/**
 * `/_redirects` lines: each release's and the pre-release's copy of a pinned
 * page goes to the one under `/tutorials/`.
 *
 * @param {{ releases: { parsed: { version: string } }[], next?: { parsed: { version: string } } }} p
 * @param {readonly string[]} pages the pinned pages' slugs (`pinnedTutorials`)
 */
export function tutorialRedirects({ releases, next }, pages) {
  const bases = releases.map(({ parsed }) => `/v${parsed.version}`);
  if (next) bases.push('/next');
  let lines = '';
  for (const base of bases) {
    for (const slug of pages) {
      const from = slug === '' ? `${base}/tutorials` : `${base}/tutorials/${slug}`;
      const to = slug === '' ? '/tutorials/' : `/tutorials/${slug}/`;
      lines += `${from} ${to} 301\n${from}/ ${to} 301\n`;
    }
  }
  return lines;
}
