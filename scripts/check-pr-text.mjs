#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A pull request's own text leaves out what this repository's files leave
 * out (`text-scan.mjs`: internal process markers and the names the
 * repository doesn't use), and internal tracking references
 * (`ID_MARKERS`, less `ALLOWED_TERMS`). That text is its title and
 * description, which become the squash commit's message, and the messages
 * of its own commits, which GitHub shows. History already on the base
 * branch isn't checked.
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
 *
 * `--message <path>` checks one commit message instead: the `commit-msg`
 * hook's, before the commit exists, when rewording it is still easy. Its
 * comment lines (`#`, or `core.commentChar`) and anything below git's
 * scissors line are left out, as git leaves them out of the commit.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ALLOWED_TERMS, ID_MARKERS, MARKERS, loadNames, scanText } from './text-scan.mjs';

const NAME = 'check-pr-text';

/** What a pull request's own text is checked for. */
const PR_RULES = {
  markers: [...MARKERS, ...ID_MARKERS],
  allowed: ALLOWED_TERMS.map((t) => t.term),
};

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

/**
 * A commit message as git will store it: without its comment lines, and
 * without anything from the scissors line down.
 */
export function commitMessageText(raw, commentChar = '#') {
  const lines = [];
  for (const line of raw.split('\n')) {
    if (
      line.replace(/\r$/, '') ===
      `${commentChar} ------------------------ >8 ------------------------`
    )
      break;
    lines.push(line.startsWith(commentChar) ? '' : line);
  }
  return lines.join('\n');
}

/**
 * One line per problem: where it is, and what (a marker's line; never a
 * name). `options` override the pull request rules (`names`, `markers`,
 * `allowed`).
 */
export function prTextProblems(texts, options = {}) {
  const problems = [];
  for (const { where, text } of texts) {
    for (const p of scanText(text, { ...PR_RULES, ...options })) {
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
  const namesPath = option('--names');
  const options =
    namesPath === undefined
      ? {}
      : { names: loadNames(JSON.parse(readFileSync(namesPath, 'utf8'))) };
  const messagePath = option('--message');
  if (messagePath !== undefined) {
    checkMessage(readFileSync(messagePath, 'utf8'), options);
    return;
  }
  const eventPath = option('--event') ?? process.env.GITHUB_EVENT_PATH;
  if (eventPath === undefined)
    throw new Error('no event: pass --event <path> or set GITHUB_EVENT_PATH');
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
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
        "Edit the title or description (this check runs again). The squash commit's message is the title and description. A pushed commit's message changes only by rewriting the branch, or by moving the work to a new branch and pull request; the commit-msg hook (scripts/hooks, installed by pnpm install) catches it before the commit exists.",
      ].join('\n'),
    );
    process.exit(1);
  }
  console.log(`${NAME}: ${texts.length} text(s) checked (title, description, commits): clean`);
}

/** The `commit-msg` hook's check: one message, before the commit exists. */
function checkMessage(raw, options) {
  const problems = prTextProblems(
    [{ where: 'the commit message', text: commitMessageText(raw, commentChar()) }],
    options,
  );
  if (problems.length > 0) {
    console.error(
      [
        `${NAME}: the commit message has ${problems.length} problem(s):`,
        ...problems.map((p) => `  - ${p}`),
        'A pull request\'s commits are public: reword the message (see CONTRIBUTING, "Public text").',
      ].join('\n'),
    );
    process.exit(1);
  }
}

/** git's comment character: `core.commentChar`, else `#` (and `#` for `auto`). */
function commentChar() {
  try {
    const value = execFileSync('git', ['config', '--get', 'core.commentChar'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return value.length === 1 ? value : '#';
  } catch {
    return '#';
  }
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
