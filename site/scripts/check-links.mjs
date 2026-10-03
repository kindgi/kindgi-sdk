#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * Internal-link gate for the built site: every `href` and `src` that stays
 * on the site resolves to a built page or file.
 *
 * Run it on a build made under a version base (`KINDGI_DOCS_BASE=/v0.0/`):
 * versioned docs are served under `/vX.Y/`, so a root-absolute link
 * (`/guides/…`) that works at `/` breaks there. Content links must be
 * relative; this is what catches one that isn't.
 *
 * Usage: node scripts/check-links.mjs <dist dir> <base>
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const [distArg, baseArg] = process.argv.slice(2);
const dist = distArg ?? 'dist';
const base = baseArg ?? '/';

if (!existsSync(dist)) {
  console.error(`check-links: no build at ${dist}`);
  process.exit(1);
}

function* htmlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* htmlFiles(path);
    else if (name.endsWith('.html')) yield path;
  }
}

/** The built file a site path serves, or undefined. */
function servedFile(sitePath) {
  const local = decodeURIComponent(sitePath.slice(base.length));
  const candidates = [join(dist, local), join(dist, local, 'index.html')];
  return candidates.find((file) => existsSync(file) && statSync(file).isFile());
}

const LINK = /\s(?:href|src)="([^"#?]+)/g;
const broken = [];
let checked = 0;
let pages = 0;

for (const file of htmlFiles(dist)) {
  pages += 1;
  const page = `${base}${relative(dist, file).replace(/index\.html$/, '')}`;
  const html = readFileSync(file, 'utf8');
  for (const [, href] of html.matchAll(LINK)) {
    if (/^(?:[a-z]+:|\/\/)/i.test(href)) continue; // another site, mailto:, data:
    const { pathname } = new URL(href, `https://docs.invalid${page}`);
    checked += 1;
    if (!pathname.startsWith(base) || servedFile(pathname) === undefined) {
      broken.push(`${page}: ${href}`);
    }
  }
}

if (broken.length > 0) {
  console.error(`check-links: ${broken.length} broken internal link(s) under base ${base}:`);
  for (const line of broken) console.error(`  ${line}`);
  console.error(
    'Links in content must be relative (e.g. `../guides/`), so a page works under any version base.',
  );
  process.exit(1);
}
console.log(`check-links: ${pages} pages, ${checked} internal links, none broken (base ${base}).`);
