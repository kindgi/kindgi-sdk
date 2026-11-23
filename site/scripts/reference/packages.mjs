// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * One reference page per public `@kindgi/*` package, from its README.
 *
 * A README's links are rewritten for its page (`readme-links.mjs`): a link
 * to the docs becomes relative, so each version's page links within its
 * version; a link to another rendered README goes to its page; a link to
 * any other file in the repository becomes its text.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rewriteLinks } from './readme-links.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const README = `README${'.md'}`;

/** Public `@kindgi/*` packages: `{ name, description, dir, slug, pageSlug }`. */
export function publicPackages() {
  const dirs = [];
  for (const parent of ['packages', join('packages', 'adapters'), 'sdks']) {
    for (const entry of readdirSync(join(REPO, parent))) {
      const dir = join(REPO, parent, entry);
      if (statSync(dir).isDirectory() && existsSync(join(dir, 'package.json'))) dirs.push(dir);
    }
  }
  return dirs
    .map((dir) => ({ dir, manifest: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) }))
    .filter(({ manifest }) => manifest.name?.startsWith('@kindgi/') && manifest.private !== true)
    .filter(({ dir }) => existsSync(join(dir, README)))
    .map(({ dir, manifest }) => ({
      name: manifest.name,
      description: manifest.description ?? '',
      dir,
      slug: manifest.name.slice('@kindgi/'.length),
      pageSlug: `reference/packages/${manifest.name.slice('@kindgi/'.length)}`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A TypeScript fence, and a first line that names a whole file (`// src/index.ts`). */
const TS_FENCE = /^(\s*)(`{3,}|~{3,})(ts|typescript|tsx)(\s.*)?$/;
const NAMES_A_FILE = /^\/\/\s*\S+\.(?:ts|tsx|mts)\s*$/;

/**
 * A README's TypeScript examples are written for GitHub and npm: most are
 * fragments, not files to paste. Each one that doesn't name a file on its
 * first line is marked `excerpt`.
 */
export function markFragments(markdown) {
  const lines = markdown.split('\n');
  let close;
  for (let i = 0; i < lines.length; i++) {
    if (close) {
      if (lines[i].trim() === close) close = undefined;
      continue;
    }
    const fence = lines[i].match(/^\s*(`{3,}|~{3,})/);
    if (!fence) continue;
    close = fence[1];
    const ts = lines[i].match(TS_FENCE);
    const meta = ts?.[4] ?? '';
    if (ts && !NAMES_A_FILE.test(lines[i + 1] ?? '') && !/\bexcerpt\b/.test(meta)) {
      lines[i] = `${ts[1]}${ts[2]}${ts[3]} excerpt${meta}`;
    }
  }
  return lines.join('\n');
}

/**
 * The packages' pages and their overview. `links`: the page of every
 * rendered README, by its directory (`readmeLinks()`); by default, the
 * packages' own.
 */
export function packagePages(links) {
  const packages = publicPackages();
  const pages = links ?? new Map(packages.map((pkg) => [pkg.dir, pkg.pageSlug]));
  const rendered = packages.map((pkg) => {
    const readme = readFileSync(join(pkg.dir, README), 'utf8').replace(/^# .*\n+/, '');
    const body = markFragments(rewriteLinks(readme, { slug: pkg.pageSlug, dir: pkg.dir, pages }));
    return {
      slug: pkg.pageSlug,
      content: [
        '---',
        `title: ${JSON.stringify(pkg.name)}`,
        `description: ${JSON.stringify(pkg.description)}`,
        '---',
        '',
        `\`npm install ${pkg.name}\``,
        '',
        body.trimEnd(),
        '',
      ].join('\n'),
    };
  });
  const overview = [
    '---',
    'title: Packages',
    'description: Every public @kindgi/* package and what it is for.',
    'sidebar:',
    '  order: 0',
    '  label: Overview',
    '---',
    '',
    'The public `@kindgi/*` packages (Apache-2.0). They share one version. Most',
    'apps need only `@kindgi/sdk`, with `@kindgi/cli` for development; the others',
    'are its building blocks, and the pieces you swap or extend.',
    '',
    ...packages.map((pkg) => `- [\`${pkg.name}\`](${pkg.slug}/): ${pkg.description}`),
    '',
  ];
  return [{ slug: 'reference/packages/index', content: overview.join('\n') }, ...rendered];
}
