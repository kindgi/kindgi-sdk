#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A pull request's own text leaves out what this repository's files leave
 * out (`text-scan.mjs`: internal process markers and the names the
 * repository doesn't use). That text is its title and description, which
 * become the squash commit's message, and the messages of its own
 * commits. History already on the base branch isn't checked.
 *
 * It reads the `pull_request` event GitHub Actions writes
 * (`GITHUB_EVENT_PATH`): the title, the body, and the base and head
 * commits, whose range `base..head` is the pull request's own commits.
 * Any other event (the merge queue's) has nothing to check: its commit is
 * built from text already checked.
 *
 * Usage: `node scripts/check-pr-text.mjs [--event <path>] [--names <path>]`
 * (the `PR text` workflow runs it). `--names` replaces the hashed list,
 * for tests.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadNames, scanText } from './text-scan.mjs';

const NAME = 'check-pr-text';

/** `{ where, text }` for the pull request's title, description and own commits. */
export function prTexts(event, git = (args) => execFileSync('git', args, { encoding: 'utf8' })) {
  const pr = event.pull_request;
  if (pr === undefined) return [];
  const texts = [
    { where: 'the title', text: pr.title ?? '' },
    { where: 'the description', text: pr.body ?? '' },
  ];
  const base = pr.base?.sha;
  const head = pr.head?.sha;
  if (typeof base === 'string' && typeof head === 'string' && base !== head) {
    const log = git(['log', '--format=%H%x00%B%x01', `${base}..${head}`]);
    for (const entry of log.split('\x01')) {
      const [sha, message] = entry.replace(/^\n/, '').split('\x00');
      if (sha === undefined || sha === '' || message === undefined) continue;
      texts.push({ where: `commit ${sha.slice(0, 7)}`, text: message });
    }
  }
  return texts;
}

/** One line per problem: where it is, and what (a marker's line; never a name). */
export function prTextProblems(texts, options = {}) {
  const problems = [];
  for (const { where, text } of texts) {
    for (const p of scanText(text, options)) {
      problems.push(`${where}, line ${p.line}: ${p.what}${p.excerpt ? `: ${p.excerpt}` : ''}`);
    }
  }
  return problems;
}

function main(args) {
  const option = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const eventPath = option('--event') ?? process.env.GITHUB_EVENT_PATH;
  if (eventPath === undefined)
    throw new Error('no event: pass --event <path> or set GITHUB_EVENT_PATH');
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  const namesPath = option('--names');
  const options =
    namesPath === undefined
      ? {}
      : { names: loadNames(JSON.parse(readFileSync(namesPath, 'utf8'))) };
  const texts = prTexts(event);
  if (texts.length === 0) {
    console.log(`${NAME}: not a pull request; nothing to check`);
    return;
  }
  const problems = prTextProblems(texts, options);
  if (problems.length > 0) {
    console.error(
      [
        `${NAME}: the pull request's text has ${problems.length} problem(s):`,
        ...problems.map((p) => `  - ${p}`),
        "Edit the title or description (this check runs again), or reword the commit. The squash commit's message is the title and description.",
      ].join('\n'),
    );
    process.exit(1);
  }
  console.log(`${NAME}: ${texts.length} text(s) checked (title, description, commits): clean`);
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`${NAME}: ${err.message}`);
    process.exit(1);
  }
}
