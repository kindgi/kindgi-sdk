#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Keeps this repository readable on its own:
 *
 *   1. Every Markdown document referenced from a tracked source, doc or
 *      manifest (`docs/FOO.md`, `../README.md`, `SPEC.md`, …) exists in
 *      this repository — resolved relative to the referencing file, then
 *      the repository root, then (for a bare file name) any tracked file
 *      with that name.
 *   2. No internal process markers (development-phase identifiers,
 *      hand-off notes, scratch paths, internal labels, references to
 *      closed-source code) in tracked files, and none of the names the
 *      repository doesn't use (`text-scan.mjs`), in their text or paths.
 *   3. Every path a skill's frontmatter lists under `sources:` (repository-
 *      relative) is a tracked file or directory.
 *   4. A skill's links to docs.kindgi.com name this release line's docs
 *      (`/v<major>.<minor>/…`, from `@kindgi/sdk`'s version): a skill ships
 *      inside a release, and the site's root moves to the next line's docs.
 *      When a release changes the minor, this fails until the links follow.
 *      So do the links in what a package or SDK ships from its `src/` (a
 *      message the CLI prints, a template `kindgi init` writes; not tests).
 *      The CLI builds its links with `docsUrl()` (`packages/cli/src/docs-links.ts`),
 *      which follows the release on its own.
 *
 * A reference to `.claude/skills/<name>/SKILL.md` is a path in a user's
 * project, where `kindgi init` installs this repository's skills: it
 * resolves when `packages/sdk/skills/<name>/SKILL.md` is tracked.
 *
 * Usage: `pnpm run check:refs` (CI runs it).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, normalize } from 'node:path';

import { MARKERS, NAME_HIT, nameHits } from './text-scan.mjs';

const TEXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|md|json|ya?ml)$/;
/** The checks themselves: they spell out the markers. */
const SELF = new Set(['scripts/check-refs.mjs', 'scripts/text-scan.mjs']);
/** Documents that live outside this repository by design (created in a user's pack). */
const EXTERNAL_DOCS = new Set(['FEEDBACK.md']);
/** Changelogs record what releases said; the runtime's own border check skips them too. */
const NAME_EXEMPT = /(^|\/)CHANGELOG\.md$/;
// Not preceded by a path/URL character (so URL paths and %-encoded URIs don't match).
const MD_REF = /(?<![\w/.@%-])((?:\.{1,2}\/)*(?:[\w.-]+\/)*[\w.-]+\.md)\b/g;

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter((f) => f !== '');
const trackedSet = new Set(tracked);
const byName = new Set(tracked.map((f) => basename(f)));

/** `sources:` entries in a SKILL.md frontmatter block. */
function skillSources(text) {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const block = /^sources:\n((?:[ \t]+- .*(?:\n|$))+)/m.exec(frontmatter)?.[1] ?? '';
  return block
    .split('\n')
    .map((line) => line.replace(/^[ \t]+- /, '').trim())
    .filter((path) => path !== '');
}

function isTrackedPath(path) {
  const clean = path.replace(/\/$/, '');
  return trackedSet.has(clean) || tracked.some((f) => f.startsWith(`${clean}/`));
}

/** `.claude/skills/<name>/SKILL.md` in a user's project, installed from `packages/sdk/skills/`. */
function installedSkill(ref) {
  const name = /^\.claude\/skills\/([\w.-]+)\/SKILL\.md$/.exec(ref)?.[1];
  return name !== undefined && trackedSet.has(`packages/sdk/skills/${name}/SKILL.md`);
}

function resolves(from, ref) {
  if (EXTERNAL_DOCS.has(basename(ref)) || installedSkill(ref)) return true;
  const candidates = [normalize(join(dirname(from), ref)), normalize(ref)];
  if (candidates.some((c) => trackedSet.has(c))) return true;
  // A bare file name (no directory part) may name any tracked file.
  return !ref.includes('/') && byName.has(ref);
}

const sdkVersion = JSON.parse(
  readFileSync(join(root, 'packages/sdk/package.json'), 'utf8'),
).version;
const docsLine = `https://docs.kindgi.com/v${sdkVersion.split('.').slice(0, 2).join('.')}/`;
const DOCS_URL = /https:\/\/docs\.kindgi\.com\/[^\s)>`'"]*/g;
/** What a package or SDK ships from its `src/`, any file type, its tests aside (rule 4). */
const SHIPPED = /^(?:packages\/[\w-]+|sdks\/(?:[\w-]+\/)*?[\w-]+)\/src\/(?!test\/)(?!.*\.test\.)/;

const problems = [];
for (const file of tracked) {
  if (nameHits(file) > 0) problems.push(`${file}: its path holds ${NAME_HIT}`);
  const shipped = SHIPPED.test(file);
  if ((!TEXT.test(file) && !shipped) || SELF.has(file)) continue;
  const text = readFileSync(join(root, file), 'utf8');
  const skill = basename(file) === 'SKILL.md';
  if (skill) {
    for (const source of skillSources(text)) {
      if (!isTrackedPath(source))
        problems.push(`${file}: sources lists ${source}, which is not in this repository`);
    }
  }
  if (skill || shipped) {
    for (const url of text.match(DOCS_URL) ?? []) {
      if (!url.startsWith(docsLine))
        problems.push(
          skill
            ? `${file}: links ${url}; a skill links this release line's docs (${docsLine}…)`
            : `${file}: links ${url}; what ships links this release line's docs (${docsLine}…; in the CLI, docsUrl() builds it)`,
        );
    }
  }
  if (!TEXT.test(file)) continue;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const match of line.matchAll(MD_REF)) {
      const ref = match[1];
      if (!resolves(file, ref))
        problems.push(`${file}:${i + 1}: references ${ref}, which is not in this repository`);
    }
    for (const [re, what] of MARKERS) {
      if (re.test(line)) problems.push(`${file}:${i + 1}: ${what}: ${line.trim().slice(0, 120)}`);
    }
    if (!NAME_EXEMPT.test(file) && nameHits(line) > 0) {
      problems.push(`${file}:${i + 1}: ${NAME_HIT}`);
    }
  });
}

if (problems.length > 0) {
  console.error(`\nReference check FAILED — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\nPoint only at documents in this repository, and keep internal process notes out of it.\n',
  );
  process.exit(1);
}
console.log(`Reference check OK — ${tracked.length} tracked files.`);
