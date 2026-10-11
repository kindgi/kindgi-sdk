// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What a build fixes in hand-written pages, so a versioned build describes its
 * own release:
 *
 * - **Links into the repository.** Pages link `github.com/kindgi/kindgi-sdk/
 *   tree/main/…` (or `blob/main`), which is right on GitHub and in the
 *   preview. A build for a release (`KINDGI_DOCS_REF`, its tag) points them at
 *   the tag instead, as the generated package pages do, and fails if any page
 *   still points at `main`.
 * - **The release's version.** `{{kindgi.version}}` in a page becomes the
 *   version the build is for: the CLI's at the ref being built. The JVM SDKs
 *   are released at the CLI's version (lockstep), so a Maven or sbt snippet
 *   can use it. In code blocks it's filled before highlighting (an Expressive
 *   Code plugin), elsewhere in the built pages and `llms*.txt`. In MDX
 *   prose, put it in inline code: `{` starts an expression there.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = 'https://github.com/kindgi/kindgi-sdk';
export const VERSION_TOKEN = '{{kindgi.version}}';

/** The version a build is for: the CLI's in this checkout. */
export function docsVersion() {
  const cli = new URL('../../packages/cli/package.json', import.meta.url);
  return JSON.parse(readFileSync(cli, 'utf8')).version;
}

/** `text` with every `{{kindgi.version}}` replaced by `version`. */
export function fillVersion(text, version) {
  return text.replaceAll(VERSION_TOKEN, version);
}

const MAIN_LINK = /https:\/\/github\.com\/kindgi\/kindgi-sdk\/(tree|blob)\/main(?=[/"'#?)\s<&]|$)/g;

/** `text` with its `tree/main` and `blob/main` links pointed at `ref`. */
export function pinRepoLinks(text, ref) {
  if (ref === 'main') return text;
  return text.replace(MAIN_LINK, (_, kind) => `${REPO}/${kind}/${ref}`);
}

// Edit links (`edit/main`) are meant for main: a fix goes there.
const TO_MAIN =
  /github\.com\/kindgi\/kindgi-sdk\/(?:tree|blob|raw)\/main(?=[/"'#?)\s<&]|$)|raw\.githubusercontent\.com\/kindgi\/kindgi-sdk\/(?:refs\/heads\/)?main\//g;

/** The links in `text` that read the repository at `main`. */
export function linksToMain(text) {
  return [...text.matchAll(TO_MAIN)].map((match) => match[0]);
}

/** An Expressive Code plugin: `{{kindgi.version}}` in a code block, filled before highlighting. */
export function versionInCode(version) {
  return {
    name: 'kindgi-version',
    hooks: {
      preprocessCode: ({ codeBlock }) => {
        for (const line of codeBlock.getLines()) {
          let at = line.text.indexOf(VERSION_TOKEN);
          while (at !== -1) {
            line.editText(at, at + VERSION_TOKEN.length, version);
            at = line.text.indexOf(VERSION_TOKEN, at + version.length);
          }
        }
      },
    },
  };
}

function* builtFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* builtFiles(path);
    else if (name.endsWith('.html') || name.endsWith('.txt')) yield path;
  }
}

/**
 * Fixes one built file in place. Returns whether it changed, and, in a
 * release's build, the links that still read `main`.
 */
function fixFile(file, { ref, version }) {
  const before = readFileSync(file, 'utf8');
  const after = pinRepoLinks(fillVersion(before, version), ref);
  if (after !== before) writeFileSync(file, after);
  return {
    changed: after !== before,
    toMain: ref === 'main' ? [] : [...new Set(linksToMain(after))],
  };
}

const HOW_TO_LINK =
  "Link into the repository as https://github.com/kindgi/kindgi-sdk/tree/main/… (or blob/main/…), which a release's build points at its tag.";

/**
 * Fixes the built pages and `llms*.txt` (see the module comment). Listed
 * before Starlight, so its search index reads the fixed pages.
 */
export function versionedPages({ ref, version }) {
  return {
    name: 'kindgi-versioned-pages',
    hooks: {
      'astro:build:done': ({ dir, logger }) => {
        const root = fileURLToPath(dir);
        const problems = [];
        let fixed = 0;
        for (const file of builtFiles(root)) {
          const { changed, toMain } = fixFile(file, { ref, version });
          if (changed) fixed += 1;
          for (const link of toMain) problems.push(`${relative(root, file)}: ${link}`);
        }
        if (problems.length > 0) {
          const list = problems.join('\n  ');
          throw new Error(
            `${problems.length} link(s) in the ${ref} build still read main:\n  ${list}\n${HOW_TO_LINK}`,
          );
        }
        logger.info(`${fixed} file(s) fixed for ${ref} (${version}).`);
      },
    },
  };
}
