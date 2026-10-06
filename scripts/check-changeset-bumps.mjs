#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * While release candidates are out (Changesets pre mode,
 * `.changeset/pre.json`), every changeset is a `patch`: a `minor` or
 * `major` moves the whole fixed group to the next minor or major, so the
 * candidates being tried stop being the release that ships.
 *
 * A changeset that means to move the version anyway says so in its body,
 * on a line `Release-decision: <who decided, and when>`.
 *
 * Usage: `node scripts/check-changeset-bumps.mjs` (CI runs it on every
 * pull request). Outside pre mode it checks nothing.
 */

import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'check-changeset-bumps';
const DECISION = /^Release-decision:\s*\S/m;

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
 * The problems with `changesets` (`{ file, text }`) in pre mode: one per
 * changeset with a `minor` or `major` bump and no `Release-decision:` line.
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

function main() {
  const dir = join(process.cwd(), '.changeset');
  let pre;
  try {
    pre = JSON.parse(readFileSync(join(dir, 'pre.json'), 'utf8'));
  } catch {
    console.log(`${NAME}: not in pre mode; nothing to check`);
    return;
  }
  if (pre.mode !== 'pre') {
    console.log(`${NAME}: pre mode exited; nothing to check`);
    return;
  }
  const changesets = readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => ({ file: `.changeset/${f}`, text: readFileSync(join(dir, f), 'utf8') }));
  const problems = bumpProblems(changesets);
  if (problems.length > 0) {
    console.error(
      [
        `${NAME}: in pre mode (\`${pre.tag}\` candidates), every changeset is a patch. These would move the release to the next minor or major:`,
        ...problems.map((p) => `  - ${p}`),
        'Make them `patch`, or, when the release is meant to move, add a line `Release-decision: <who decided, and when>` to the changeset.',
      ].join('\n'),
    );
    process.exit(1);
  }
  console.log(
    `${NAME}: ${changesets.length} changeset(s), all patch-level in pre mode (${pre.tag})`,
  );
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
