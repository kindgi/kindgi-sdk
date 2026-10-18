#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Docs ship with the change: a pull request that changes a public contract
 * also changes the docs, or says why it doesn't.
 *
 * The contracts are what users build against: the HTTP API's spec, the
 * environment variables, the wire schemas, the CLI's commands, the SDKs'
 * public sources. The docs are the site's pages, the skills, a README, or
 * the contributor docs. A pull request whose changes (since it left its
 * base) touch a contract and none of the docs passes only with a line
 * `No-docs: <reason>` in a commit message of its own (for example, a
 * refactor with no visible change).
 *
 * Its own commits are the ones since it left its base, less what other
 * pull requests' heads carry: a branch built on another pull request's
 * branch has that branch's commits, and their `No-docs:` lines are about
 * the other pull request. That covers the heads in this branch's history,
 * and the heads of the pull requests squashed into the base (a subject in
 * the base's history ending in `(#<n>)`), so an older head of one, merged
 * in before it moved on, counts as its too. The same goes for this pull
 * request's own commits when one of those carries them: they landed with
 * it, and once this branch merges the base they leave its diff.
 *
 * Three cases still count another pull request's lines here: an older head
 * of one closed without merging; an older head of an open one that isn't
 * the base; and a squash whose subject doesn't end in `(#<n>)`.
 *
 * The generated reference (CLI, env vars, schemas, SDK APIs) follows the
 * code by itself; this check is about the pages people write.
 *
 * In GitHub Actions it reads the `pull_request` event (`GITHUB_EVENT_PATH`):
 * the pull request is the event's, and the base is what GitHub's merge of
 * its head (HEAD there) merged into, else the event's base commit.
 * Elsewhere `gh pr view` finds the branch's open pull request, and its
 * base. The heads come from `git ls-remote origin`, and a squashed pull
 * request's head is fetched when it isn't here. In Actions, a step that
 * fails fails the check; elsewhere it prints a warning, and those commits
 * count.
 *
 * Usage: `pnpm run check:docs-ship [<base ref>] [--pr <n>] [--event <path>]`
 *   <base ref>      compare with this instead of the pull request's base
 *                   (without a pull request: `origin/main`)
 *   --pr <n>        the pull request to check the branch as, open or not
 *   --event <path>  a `pull_request` event to read instead of
 *                   `GITHUB_EVENT_PATH`
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NAME = 'check-docs-ship';

const CONTRACTS = [
  'packages/api/openapi.json',
  'packages/env-schema/src/',
  'packages/specs/schemas/',
  'packages/cli/src/commands/',
  'packages/sdk/src/',
  'sdks/python/src/kindgi/',
  'sdks/java/kindgi-client/src/main/',
  'sdks/java/kindgi-models/src/main/',
  'sdks/java/kindgi-pack/src/main/',
];
const DOCS = [
  /^site\/src\/content\/docs\//,
  /^packages\/sdk\/skills\//,
  /(^|\/)README\.md$/,
  /^docs\//,
];
const OPT_OUT = /^No-docs:\s*\S.*$/m;

/**
 * The pull request of a GitHub event, `{ number, base, head }` (commits);
 * `undefined` for any other event.
 */
export function eventPull(event) {
  const pr = event.pull_request;
  if (pr === undefined) return undefined;
  const pull = { number: pr.number, base: pr.base?.sha, head: pr.head?.sha };
  if (
    !Number.isInteger(pull.number) ||
    typeof pull.base !== 'string' ||
    typeof pull.head !== 'string'
  ) {
    throw new Error('the pull_request event has no number, base.sha or head.sha');
  }
  return pull;
}

/** The `refs/pull/<n>/head` lines of `git ls-remote`, as `{ number, sha }`. */
export function pullHeads(listing) {
  const heads = [];
  for (const line of listing.split('\n')) {
    const match = /^([0-9a-f]+)\trefs\/pull\/(\d+)\/head$/.exec(line);
    if (match) heads.push({ number: Number(match[2]), sha: match[1] });
  }
  return heads;
}

/** The pull request numbers that subjects end with, `(#<n>)`: a squash's. */
export function squashedNumbers(subjects) {
  const numbers = new Set();
  for (const subject of subjects.split('\n')) {
    const match = /\(#(\d+)\)$/.exec(subject.trim());
    if (match) numbers.add(Number(match[1]));
  }
  return numbers;
}

/**
 * The other pull requests' heads that `keep` keeps. The pull request's own
 * head is left out by its number and by its commit: one branch can be open
 * as two pull requests.
 */
export function otherHeads(heads, pull, keep) {
  return heads.filter(
    (head) => head.number !== pull.number && head.sha !== pull.head && keep(head),
  );
}

const git = (...args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  }).trim();

const warn = (what) => console.log(`${NAME}: warning: ${what}`);

/** The first line of a failed command's error output, else its message. */
function why(err) {
  return (
    String(err.stderr ?? '')
      .trim()
      .split('\n')[0] || err.message
  );
}

/** `{ sha, message }` for each commit `git log` lists for `revs`. */
function commits(revs) {
  const log = git('log', '--format=%H%x00%B%x01', ...revs);
  const list = [];
  for (const entry of log.split('\x01')) {
    const [sha, message] = entry.replace(/^\n/, '').split('\x00');
    if (sha === undefined || sha === '' || message === undefined) continue;
    list.push({ sha, message });
  }
  return list;
}

/** The commits since `mergeBase`, less what the `others` heads carry. */
function ownCommits(mergeBase, others) {
  const not = others.length === 0 ? [] : ['--not', ...others.map((head) => head.sha)];
  return commits([`${mergeBase}..HEAD`, ...not]);
}

/** The commit's `No-docs:` line. */
const optOut = (commit) => commit.message.match(OPT_OUT)?.[0].trim();

/** Of `heads`, those whose commits aren't here. */
function missing(heads) {
  if (heads.length === 0) return [];
  const answers = execFileSync('git', ['cat-file', '--batch-check'], {
    input: `${heads.map((head) => `${head.sha}^{commit}`).join('\n')}\n`,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).split('\n');
  return heads.filter((_, i) => answers[i].endsWith(' missing'));
}

/** `{ base, pr, event }` from the command line. */
function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = { '--pr': 'pr', '--event': 'event' }[args[i]];
    if (flag !== undefined) {
      if (args[i + 1] === undefined) throw new Error(`${args[i]} takes a value`);
      options[flag] = args[++i];
    } else if (args[i].startsWith('--') || options.base !== undefined) {
      throw new Error(`unexpected argument ${args[i]}`);
    } else {
      options.base = args[i];
    }
  }
  if (options.pr !== undefined && !/^\d+$/.test(options.pr)) {
    throw new Error('--pr takes a pull request number');
  }
  return options;
}

/**
 * The branch's pull request outside Actions, from `gh pr view`, with its
 * base commit fetched when it isn't here yet. Without a number, only an
 * open one: gh can answer with a closed or merged one for the branch name.
 */
function viewPull(number) {
  let view;
  try {
    view = JSON.parse(
      execFileSync(
        'gh',
        [
          'pr',
          'view',
          ...(number === undefined ? [] : [number]),
          '--json',
          'number,state,baseRefName,baseRefOid,headRefOid',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
  } catch (err) {
    throw new Error(`no pull request found (${why(err)})`);
  }
  if (number === undefined && view.state !== 'OPEN') {
    throw new Error(
      `no open pull request found (#${view.number} is ${String(view.state).toLowerCase()})`,
    );
  }
  const pull = { number: view.number, base: view.baseRefOid, head: view.headRefOid };
  const base = [{ sha: pull.base }];
  const unusable = (what) => new Error(`can't use pull request #${pull.number} (${what})`);
  if (missing(base).length > 0) {
    try {
      git('fetch', '--quiet', 'origin', `refs/heads/${view.baseRefName}`);
    } catch (err) {
      throw unusable(`fetching its base: ${why(err)}`);
    }
  }
  if (missing(base).length > 0) {
    throw unusable(`its base commit ${pull.base.slice(0, 7)} isn't here after a fetch`);
  }
  return pull;
}

/**
 * The pull request and whether a failure is the check's (`strict`): the
 * event's in Actions, else the one `gh pr view` finds, else none.
 */
function findPull(options) {
  const eventPath = options.event ?? process.env.GITHUB_EVENT_PATH;
  if (eventPath !== undefined) {
    const pull = eventPull(JSON.parse(readFileSync(eventPath, 'utf8')));
    if (pull !== undefined) return { pull, strict: true };
  }
  try {
    return { pull: viewPull(options.pr), strict: false };
  } catch (err) {
    const base = options.base ?? 'origin/main';
    warn(`${err.message}; comparing with ${base}, and every commit since counts.`);
    return { pull: undefined, strict: false };
  }
}

/**
 * A skill is a view of site pages (site/skills-sources.json): when its pages
 * change and it doesn't, say so. A reminder to review it, not a failure:
 * skills change only with a before/after check.
 */
function remindSkills(changed) {
  const sourcesFile = 'site/skills-sources.json';
  if (!existsSync(sourcesFile)) return;
  const { skills } = JSON.parse(readFileSync(sourcesFile, 'utf8'));
  for (const [name, skill] of Object.entries(skills)) {
    const pages = skill.pages.filter((page) =>
      changed.some((path) => path.replace(/\.mdx?$/, '') === `site/src/content/docs/${page}`),
    );
    const skillChanged = changed.some((path) => path.startsWith(`packages/sdk/skills/${name}/`));
    if (pages.length > 0 && !skillChanged) {
      console.log(`${NAME}: review skill ${name}; its pages changed: ${pages.join(', ')}`);
    }
  }
}

/** Every pull request's head on origin; `undefined` when it can't say (outside Actions). */
function listHeads(strict) {
  try {
    return pullHeads(
      execFileSync('git', ['ls-remote', 'origin', 'refs/pull/*/head'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch (err) {
    if (strict) throw new Error(`can't list the other pull requests' heads: ${why(err)}`);
    warn(`can't list the other pull requests' heads (${why(err)}); every commit since counts.`);
    return undefined;
  }
}

/**
 * The heads of the other pull requests squashed into `base` (anywhere in its
 * history), each fetched when it isn't here. Outside Actions, one that can't
 * be fetched is left out, with a warning.
 */
function squashedHeads(heads, pull, base, strict) {
  const numbers = squashedNumbers(git('log', '--format=%s', base));
  const squashed = otherHeads(heads, pull, (head) => numbers.has(head.number));
  const absent = missing(squashed);
  if (absent.length === 0) return squashed;
  console.log(`${NAME}: fetching ${absent.length} squashed pull request head(s)`);
  try {
    git(
      'fetch',
      '--quiet',
      '--no-tags',
      'origin',
      ...absent.map((h) => `refs/pull/${h.number}/head`),
    );
  } catch (err) {
    if (strict) throw new Error(`can't fetch the squashed pull requests' heads: ${why(err)}`);
    warn(`can't fetch the squashed pull requests' heads (${why(err)}); their commits count.`);
  }
  const still = new Set(missing(squashed).map((head) => head.sha));
  if (still.size > 0 && strict) {
    throw new Error(`${still.size} squashed pull request head(s) aren't here after a fetch`);
  }
  return squashed.filter((head) => !still.has(head.sha));
}

/**
 * A pull request that carries each of `skipped`: one whose head is in this
 * branch's history first, else one squashed into the base.
 */
function carriers(skipped, mergeBase, inHistory, squashed) {
  const carrier = new Map();
  for (const [set, label] of [
    [inHistory, ''],
    [squashed, ', squashed into the base'],
  ]) {
    if (set.length === 0 || skipped.every((c) => carrier.has(c.sha))) continue;
    const bySha = new Map(set.map((head) => [head.sha, head]));
    const reached = git('log', '--format=%H %S', ...bySha.keys(), `^${mergeBase}`);
    for (const line of reached.split('\n')) {
      const [sha, from] = line.split(' ');
      const head = bySha.get(from);
      if (head !== undefined && !carrier.has(sha)) carrier.set(sha, `#${head.number}${label}`);
    }
  }
  return carrier;
}

/**
 * The pull request's base. In Actions, HEAD is GitHub's merge of its head
 * into its base, and that merge's first parent is the base this diff is
 * against. The event's base commit is recorded at another moment and can
 * differ: when it's older, what lies between the two is other pull
 * requests'.
 */
function pullBase(pull) {
  const [, first, second, ...more] = git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ');
  return second === pull.head && more.length === 0 ? first : pull.base;
}

function main(args) {
  const options = parseArgs(args);
  const { pull, strict } = findPull(options);
  const base = options.base ?? (pull === undefined ? 'origin/main' : pullBase(pull));
  const mergeBase = git('merge-base', base, 'HEAD');
  const changed = git('diff', '--name-only', `${mergeBase}...HEAD`).split('\n').filter(Boolean);
  remindSkills(changed);

  const contracts = changed.filter((path) => CONTRACTS.some((prefix) => path.startsWith(prefix)));
  if (contracts.length === 0) {
    console.log(`${NAME}: no public contract changed.`);
    return;
  }
  if (changed.some((path) => DOCS.some((pattern) => pattern.test(path)))) {
    console.log(`${NAME}: ${contracts.length} contract file(s) changed, with docs.`);
    return;
  }

  // Its own commits: less what the other pull requests' heads in this
  // branch's history carry, then, before a line counts, less what those
  // squashed into the base carry (this branch can hold an older head of one,
  // merged in before it moved on).
  const heads = pull === undefined ? undefined : listHeads(strict);
  let inHistory = [];
  if (heads !== undefined) {
    const range = new Set(git('rev-list', `${mergeBase}..HEAD`).split('\n').filter(Boolean));
    inHistory = otherHeads(heads, pull, (head) => range.has(head.sha));
  }
  let reason = ownCommits(mergeBase, inHistory).find(optOut);
  let squashed = [];
  if (reason !== undefined && heads !== undefined) {
    squashed = squashedHeads(heads, pull, base, strict);
    reason = ownCommits(mergeBase, [...inHistory, ...squashed]).find(optOut);
  }
  if (reason !== undefined) {
    console.log(
      `${NAME}: contracts changed without docs; ${reason.sha.slice(0, 7)}: ${optOut(reason)}`,
    );
    return;
  }

  const own = new Set(ownCommits(mergeBase, [...inHistory, ...squashed]).map((c) => c.sha));
  const skipped = commits([`${mergeBase}..HEAD`]).filter((c) => !own.has(c.sha) && optOut(c));
  const carrier = carriers(skipped, mergeBase, inHistory, squashed);
  console.error(
    [
      `${NAME}: this branch changes a public contract but no docs:`,
      ...contracts.map((path) => `  ${path}`),
      '',
      'Update the pages that describe it (site/src/content/docs/, a skill, a README),',
      "or add a line `No-docs: <why>` to a commit message of this pull request's own.",
      ...(skipped.length === 0
        ? []
        : [
            'Not counted, as other pull requests carry them:',
            ...skipped.map(
              (c) =>
                `  skipped in ${c.sha.slice(0, 7)} (carried by ${carrier.get(c.sha)}): ${optOut(c)}`,
            ),
          ]),
    ].join('\n'),
  );
  process.exitCode = 1;
}

// `argv[1]` as its real path, as `import.meta.url` is: run through a
// symlink, the check still runs.
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
