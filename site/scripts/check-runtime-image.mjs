#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * A page that names the runtime image names the one its docs line runs: the
 * image `kindgi dev` pins (`DEFAULT_RUNTIME_IMAGE` in
 * packages/cli/src/dev/runtime-image.ts), so a command copied from the page
 * pulls and runs the release the page describes. A change that moves the
 * pin moves the pages with it.
 *
 * This fails on a reference in a hand-written page, in prose or in code:
 *
 * - **Another tag:** `kindgi/runtime:0.3.0` where the CLI pins 0.4.0.
 * - **Another digest:** `kindgi/runtime:…@sha256:<digest>` with a digest
 *   that isn't the pin's.
 * - **Another registry:** `ghcr.io/kindgi/runtime`, or a bare
 *   `kindgi/runtime`, which Docker pulls from Docker Hub, where the CLI pins
 *   registry.kindgi.com.
 * - **The old registry:** `quay.io/kindgi`, where the runtime was before
 *   registry.kindgi.com.
 *
 * A reference with no tag names no release, and nor does a placeholder, so
 * they're fine: a tag or digest that starts with neither a letter nor a
 * digit (`<version>`, `{{kindgi.version}}`, `…`). A digest after a
 * placeholder tag is still the pin's or fails. Emphasis or a tag right
 * after a reference (`**`, `_`, `<br/>`) isn't part of it. Release notes pages
 * (`releases/`) aren't read, and nor are the sections in `OLDER_RELEASES`,
 * such as operate.md's steps for an older release, which name the image
 * that release ran. A section runs from its heading to the next heading of
 * its level or above.
 *
 * Usage: node scripts/check-runtime-image.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = 'src/content/docs/';
const PIN = join(site, '..', 'packages', 'cli', 'src', 'dev', 'runtime-image.ts');

/** The sections that name an older release's image, by page (its slug) and heading. */
export const OLDER_RELEASES = [
  { page: 'deploy/self-hosted/operate', heading: '### Runtime 0.1.5.1' },
  { page: 'deploy/self-hosted/operate', heading: '### Runtime 0.1.4.2' },
  { page: 'deploy/self-hosted/operate', heading: '### Runtime 0.1.4.1' },
];

/**
 * A runtime image reference, `[<registry>/]kindgi/runtime[:<tag>][@sha256:<digest>]`:
 * the registry is a host, with a port or without; the tag is a whole
 * placeholder (`<version>`, `{{kindgi.version}}`) or runs, as the digest
 * does, to the first character that ends one in prose, code or markup.
 */
const REFERENCE =
  /(?<![A-Za-z0-9.-])(?:([A-Za-z0-9.-]+(?::\d+)?)\/)?kindgi\/runtime(?![\w-])(?::(<[^\s<>]*>|\{\{[^\s{}]*\}\}|[^\s@`'"()[\]{},;|*<>]+))?(?:@sha256:([^\s`'"()[\]{},;|*<>]+))?/g;
const OLD = 'quay.io';
const OLD_REGISTRY = /\bquay\.io\/kindgi\b/g;
/** A reference as written: up to the first character that ends one in prose, code or markup. */
const END = /^[^\s`'"()[\]{},;|*<>]+/;
/** What ends a sentence or emphasis after a reference, not part of it. */
const TAIL = /[.:_]+$/;
/** A value that names a release, not a placeholder for one. */
const CONCRETE = /^[A-Za-z0-9]/;

/**
 * The image this checkout's CLI pins, from the source of runtime-image.ts:
 * the whole reference, its registry, its tag and its digest.
 */
export function pinnedImage(source = readFileSync(PIN, 'utf8')) {
  const image = source.match(/export const DEFAULT_RUNTIME_IMAGE\s*=\s*'([^']+)'/)?.[1];
  const parts = image?.match(
    /^([A-Za-z0-9.-]+(?::\d+)?)\/kindgi\/runtime:([\w.-]+)@sha256:([0-9a-f]{64})$/,
  );
  if (!parts) {
    throw new Error(
      "check-runtime-image: runtime-image.ts has no DEFAULT_RUNTIME_IMAGE = '<registry>/kindgi/runtime:<tag>@sha256:<digest>'",
    );
  }
  return { image, registry: parts[1], tag: parts[2], digest: parts[3] };
}

/** Where the front matter ends: the index of the line after its closing `---`, or 0. */
function frontmatterEnd(lines) {
  if (lines[0]?.trim() !== '---') return 0;
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  return close === -1 ? 0 : close + 1;
}

/** The code block open after a line: `fence` until its closing marker, or the one the line opens. */
function fenceAfter(fence, trimmed) {
  const marker = trimmed.match(/^(`{3,}|~{3,})/)?.[1];
  if (fence) return marker?.startsWith(fence) && marker === trimmed ? undefined : fence;
  return marker;
}

/**
 * The older-release section a heading of `level` leaves the lines in, by
 * its level (0 for none): its own if `older` names it, else the one it's
 * in, unless it ends that one. Adds a heading `older` names to `seen`.
 */
function sectionAfter(inside, level, trimmed, older, seen) {
  const text = trimmed.replace(/\s+/g, ' ');
  if (older.includes(text)) {
    seen.add(text);
    return level;
  }
  return inside && level <= inside ? 0 : inside;
}

/**
 * Each line of a page, with its number and whether it's in one of the
 * sections `older` names by heading, and the headings of `older` the page
 * has. A heading starts its line; a `#` line in front matter or a code
 * block isn't one.
 */
function linesOf(source, older) {
  const lines = source.split('\n');
  const start = frontmatterEnd(lines);
  const result = [];
  const seen = new Set();
  let fence;
  let inside = 0;
  lines.forEach((line, index) => {
    // Front matter has no code blocks and no headings.
    if (index >= start) {
      const heading = fence ? undefined : line.match(/^(#{1,6})\s/);
      fence = fenceAfter(fence, line.trim());
      if (heading) inside = sectionAfter(inside, heading[1].length, line.trim(), older, seen);
    }
    result.push({ number: index + 1, line, older: inside > 0 });
  });
  return { lines: result, seen };
}

/**
 * What's wrong with a reference's registry against `pin`'s, if anything.
 * The old registry has its own problem.
 */
function registryProblem(registry, pin) {
  if (registry === pin.registry || registry === OLD) return undefined;
  return registry
    ? `registry ${registry}, not ${pin.registry}`
    : `no registry (Docker Hub), not ${pin.registry}`;
}

/** What's wrong with one reference against `pin`: its registry, tag and digest, each or none. */
function referenceProblems(registry, rawTag, rawDigest, pin) {
  const problems = [];
  const elsewhere = registryProblem(registry, pin);
  if (elsewhere) problems.push(elsewhere);
  const tag = rawTag?.replace(TAIL, '');
  if (tag && CONCRETE.test(tag) && tag !== pin.tag) problems.push(`tag ${tag}, not ${pin.tag}`);
  const digest = rawDigest?.match(/^[0-9a-f]+/i)?.[0];
  if (rawDigest && CONCRETE.test(rawDigest) && digest !== pin.digest) {
    problems.push(
      `digest ${digest?.slice(0, 12) ?? rawDigest}…, not the pin's ${pin.digest.slice(0, 12)}…`,
    );
  }
  return problems;
}

/**
 * What's wrong with each image reference in a page's source, against `pin`
 * (`pinnedImage()`), outside the sections `older` names by heading: one
 * entry per problem, with its line and the reference as written. `counted`
 * is the number of runtime image references read, `skipped` those in the
 * older-release sections, and `seen` the headings of `older` the page has.
 */
export function check(source, pin, older = []) {
  const problems = [];
  let counted = 0;
  let skipped = 0;
  const { lines, seen } = linesOf(source, older);
  for (const { number, line, older: isOlder } of lines) {
    const found = [...line.matchAll(REFERENCE)];
    const old = [...line.matchAll(OLD_REGISTRY)];
    if (isOlder) {
      skipped += found.length;
      continue;
    }
    counted += found.length;
    for (const match of old) {
      const reference = line.slice(match.index).match(END)[0];
      problems.push({ line: number, reference, problem: 'the old registry, quay.io' });
    }
    for (const [written, registry, rawTag, rawDigest] of found) {
      // A sentence's full stop isn't the reference's.
      const reference = written.replace(TAIL, '');
      for (const problem of referenceProblems(registry, rawTag, rawDigest, pin)) {
        problems.push({ line: number, reference, problem });
      }
    }
  }
  return { problems, counted, skipped, seen };
}

/** The hand-written pages this check reads: tracked, and not release notes. */
function pages() {
  return execFileSync('git', ['ls-files', '--', DOCS], { cwd: site, encoding: 'utf8' })
    .split('\n')
    .filter((path) => /\.mdx?$/.test(path) && !path.startsWith(`${DOCS}releases/`));
}

function main() {
  const pin = pinnedImage();
  const failed = [];
  let counted = 0;
  let skipped = 0;
  const found = new Set();
  for (const path of pages()) {
    const page = path.slice(DOCS.length).replace(/\.mdx?$/, '');
    const older = OLDER_RELEASES.filter((section) => section.page === page).map(
      (section) => section.heading,
    );
    const result = check(readFileSync(join(site, path), 'utf8'), pin, older);
    counted += result.counted;
    skipped += result.skipped;
    for (const heading of result.seen) found.add(`${page} ${heading}`);
    for (const problem of result.problems) failed.push({ page, ...problem });
  }
  for (const { page, heading } of OLDER_RELEASES) {
    if (!found.has(`${page} ${heading}`)) {
      console.log(
        `check-runtime-image: OLDER_RELEASES names "${heading}" in ${page}, which has no such heading: take it out.`,
      );
    }
  }
  if (failed.length > 0) {
    console.error(
      `check-runtime-image: pages that name another runtime image than this line's CLI runs (${pin.image}):`,
    );
    for (const { page, line, reference, problem } of failed) {
      console.error(`  ${page} line ${line}: ${reference}: ${problem}`);
    }
    console.error(
      "Name the image the CLI pins (packages/cli/src/dev/runtime-image.ts), or a placeholder such as <version>; an older release's steps go in a section listed in OLDER_RELEASES.",
    );
    process.exit(1);
  }
  console.log(
    `check-runtime-image: OK, ${counted} runtime image reference(s), none names another image than ${pin.registry}'s ${pin.tag}; ${skipped} in older-release sections.`,
  );
}

// Run as a script, not when a test imports it (real paths: a temp folder can be a symlink).
if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
)
  main();
