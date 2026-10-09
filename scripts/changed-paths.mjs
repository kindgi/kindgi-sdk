#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * changed-paths: whether this workflow run's changes touch any of the
 * given paths, for a workflow that reports on every pull request and
 * merge-queue group (so it can be a required check) but does its heavy work
 * only when its paths change.
 *
 *   node scripts/changed-paths.mjs 'sdks/java/**' packages/api/openapi.json …
 *
 * A pattern is a directory (`dir/**`) or a file. The run's changes are a pull
 * request's against its base, a merge-queue group's against the main it was
 * built on, and a push's against the commit before. Writes `changed=true` or
 * `changed=false` to `$GITHUB_OUTPUT` (stdout without one), and lists the
 * files that matched.
 *
 * It fails open: a manual run, a new branch, an event it doesn't know, or a
 * diff git can't make (a commit the checkout lacks) all say `changed=true`,
 * so a check is never passed by an answer it couldn't work out.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ZERO = /^0+$/;

/**
 * @param {string} file a changed file, relative to the repository's root
 * @param {readonly string[]} patterns `dir/**` or a file
 * @returns {boolean} whether the file is one of the patterns'
 */
export function matches(file, patterns) {
  return patterns.some((pattern) =>
    pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : file === pattern,
  );
}

/**
 * The commits this run's changes lie between, by its event; `undefined` when
 * there's nothing to compare (then everything counts as changed).
 *
 * @param {string} eventName `GITHUB_EVENT_NAME`
 * @param {Record<string, any>} event the event's payload (`GITHUB_EVENT_PATH`)
 * @returns {{ base: string, head: string, mergeBase: boolean } | undefined}
 */
export function range(eventName, event) {
  let found;
  if (eventName === 'pull_request') {
    found = {
      base: event.pull_request?.base?.sha,
      head: event.pull_request?.head?.sha,
      mergeBase: true,
    };
  } else if (eventName === 'merge_group') {
    found = {
      base: event.merge_group?.base_sha,
      head: event.merge_group?.head_sha,
      mergeBase: false,
    };
  } else if (eventName === 'push') {
    found = { base: event.before, head: event.after, mergeBase: false };
  }
  if (found === undefined) return undefined;
  const ok = (sha) => typeof sha === 'string' && sha !== '' && !ZERO.test(sha);
  return ok(found.base) && ok(found.head) ? found : undefined;
}

/**
 * @param {{ base: string, head: string, mergeBase: boolean }} between
 * @param {(args: string[]) => string} git runs git, returning its stdout
 * @returns {string[] | undefined} the changed files, or `undefined` when git can't say
 */
export function changedFiles(between, git) {
  try {
    const spec = between.mergeBase
      ? `${between.base}...${between.head}`
      : `${between.base}..${between.head}`;
    return git(['diff', '--name-only', spec])
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  } catch {
    return undefined;
  }
}

/**
 * @param {readonly string[]} patterns
 * @param {{ eventName: string, event: Record<string, any>, git: (args: string[]) => string }} run
 * @returns {{ changed: boolean, why: string, files: string[] }}
 */
export function decide(patterns, run) {
  const between = range(run.eventName, run.event);
  if (between === undefined) {
    return {
      changed: true,
      why: `nothing to compare for a ${run.eventName} run: everything counts`,
      files: [],
    };
  }
  const files = changedFiles(between, run.git);
  if (files === undefined) {
    return {
      changed: true,
      why: `git can't diff ${between.base}..${between.head}: everything counts`,
      files: [],
    };
  }
  const hits = files.filter((file) => matches(file, patterns));
  return {
    changed: hits.length > 0,
    why:
      hits.length > 0
        ? `${hits.length} of ${files.length} changed files match`
        : `none of ${files.length} changed files match`,
    files: hits,
  };
}

function main() {
  const patterns = process.argv.slice(2);
  if (patterns.length === 0) {
    console.error('usage: changed-paths.mjs <dir/**|file>...');
    return 2;
  }
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const event = eventPath ? JSON.parse(readFileSync(eventPath, 'utf8')) : {};
  const result = decide(patterns, {
    eventName: process.env.GITHUB_EVENT_NAME ?? '',
    event,
    git: (args) =>
      execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  });
  console.log(`changed-paths: ${result.why}`);
  for (const file of result.files.slice(0, 20)) console.log(`  ${file}`);
  const line = `changed=${result.changed}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  else process.stdout.write(line);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main());
