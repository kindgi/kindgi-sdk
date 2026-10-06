#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A changeset that would move the release to the next minor or major says
 * so: a line `Release-decision: <the version, who decided, and when>` in
 * its body. The body becomes the changelog entry, so "who" is a role (the
 * maintainers), never a person.
 *
 * Every `@kindgi/*` package shares one version (a Changesets fixed group),
 * so one `minor` moves them all. Two cases need the line:
 *
 * - **before 1.0**, every `minor` or `major`: a 0.x minor reaches no one
 *   already installed (`^0.1.x`, `kindgi>=0.1,<0.2`, the CLI's `@0.1`
 *   hints all stop below it);
 * - **while release candidates are out** (Changesets pre mode,
 *   `.changeset/pre.json`), every `minor` or `major`: the candidates being
 *   tried would stop being the release that ships.
 *
 * Usage: `node scripts/check-changeset-bumps.mjs` (CI runs it on every
 * pull request and push).
 */

import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'check-changeset-bumps';
const DECISION = /^Release-decision:\s*\S/m;
/** The fixed group's canonical package (`scripts/sync-python-version.mjs`). */
const CANONICAL_MANIFEST = join('packages', 'sdk', 'package.json');

/** The bumps a changeset's front matter declares, by package. */
export function changesetBumps(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) return [];
  return match[1]
    .split(/\r?\n/)
    .map((line) => /^\s*["']?([^"':]+)["']?\s*:\s*(major|minor|patch|none)\s*$/.exec(line))
    .filter((m) => m !== null)
    .map((m) => ({ pkg: m[1].trim(), bump: m[2] }));
}

/**
 * The problems with `changesets` (`{ file, text }`): one per changeset
 * with a `minor` or `major` bump and no `Release-decision:` line.
 */
export function bumpProblems(changesets) {
  const problems = [];
  for (const { file, text } of changesets) {
    if (DECISION.test(text)) continue;
    const big = changesetBumps(text).filter((b) => b.bump === 'minor' || b.bump === 'major');
    if (big.length === 0) continue;
    problems.push(`${file}: ${big.map((b) => `${b.pkg}: ${b.bump}`).join(', ')}`);
  }
  return problems;
}

/** Why minor and major changesets need a decision now, or `undefined` when they don't. */
export function whyDecisionNeeded({ version, pre }) {
  if (pre?.mode === 'pre') return `release candidates are out (pre mode, \`${pre.tag}\`)`;
  if (/^0\./.test(version)) return `the packages are ${version}, before 1.0`;
  return undefined;
}

function main() {
  const root = process.cwd();
  const dir = join(root, '.changeset');
  const version = JSON.parse(readFileSync(join(root, CANONICAL_MANIFEST), 'utf8')).version;
  let pre;
  try {
    pre = JSON.parse(readFileSync(join(dir, 'pre.json'), 'utf8'));
  } catch {
    pre = undefined;
  }
  const why = whyDecisionNeeded({ version, pre });
  if (why === undefined) {
    console.log(
      `${NAME}: ${version}, not in pre mode; minor and major changesets need no decision`,
    );
    return;
  }
  const changesets = readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => ({ file: `.changeset/${f}`, text: readFileSync(join(dir, f), 'utf8') }));
  const problems = bumpProblems(changesets);
  if (problems.length > 0) {
    console.error(
      [
        `${NAME}: ${why}, so a changeset is a patch unless a release decision says otherwise. These would move every @kindgi/* package to the next minor or major:`,
        ...problems.map((p) => `  - ${p}`),
        'Make them `patch`, or, when the release is meant to move, add a line `Release-decision: <the version, who decided (a role, not a person), and when>` to the changeset.',
      ].join('\n'),
    );
    process.exit(1);
  }
  console.log(`${NAME}: ${changesets.length} changeset(s), none moves the release (${why})`);
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
