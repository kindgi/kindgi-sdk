#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A pull request that changes a skill bumps its `version`: a skill is its
 * folder, `packages/sdk/skills/<name>/`, its `SKILL.md` and the files
 * beside it, and the version is in `SKILL.md`'s frontmatter. `kindgi skills
 * sync` and `kindgi dev` say which version each copy in a pack is at, so a
 * change under the same version reads as no change.
 *
 * A skill the pull request adds or removes needs nothing. Moving the docs
 * links to a new release line (`scripts/sync-docs-line.mjs`, which a Version
 * Packages pull request runs) is no change to a skill either: the files are
 * compared with each link's release line taken out.
 *
 * In GitHub Actions it reads the `pull_request` event (`GITHUB_EVENT_PATH`):
 * the pull request's head against where it left its base. Any other event
 * has nothing to check. Elsewhere it compares `HEAD` with where it left
 * `<base ref>` (default `origin/main`): committed changes only.
 *
 * Usage: `pnpm run check:skill-versions [<base ref>]`
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { range } from './changed-paths.mjs';
import { LINE_LINK } from './lib/docs-line.mjs';

const NAME = 'check-skill-versions';
const SKILLS = 'packages/sdk/skills/';
const ENTRY = 'SKILL.md';

/**
 * @param {string} file a changed file, relative to the repository's root
 * @returns {string | undefined} the skill it's a file of
 */
export function skillOf(file) {
  if (!file.startsWith(SKILLS)) return undefined;
  const [name, ...rest] = file.slice(SKILLS.length).split('/');
  return rest.length > 0 ? name : undefined;
}

/**
 * @param {string} text a `SKILL.md`
 * @returns {string | undefined} its frontmatter's `version`
 */
export function skillVersion(text) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  return frontmatter?.match(/^version:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
}

/**
 * @param {string} text a skill's file
 * @returns {string} the text with each docs link's release line taken out
 */
export function withoutDocsLine(text) {
  return text.replace(LINE_LINK, 'https://docs.kindgi.com/');
}

/**
 * The skills `changed` touches that kept their version though a file of
 * theirs changed, by name.
 *
 * @param {readonly string[]} changed the changed files
 * @param {{ read: (side: 'base' | 'head', path: string) => string | undefined,
 *           list: (side: 'base' | 'head', dir: string) => string[] }} tree
 * @returns {string[]}
 */
export function unbumped(changed, tree) {
  const names = [...new Set(changed.map(skillOf).filter((name) => name !== undefined))].sort();
  return names.filter((name) => {
    const dir = `${SKILLS}${name}/`;
    const base = tree.read('base', `${dir}${ENTRY}`);
    const head = tree.read('head', `${dir}${ENTRY}`);
    if (base === undefined || head === undefined) return false;
    if (skillVersion(base) !== skillVersion(head)) return false;
    const files = new Set([...tree.list('base', dir), ...tree.list('head', dir)]);
    return [...files].some((path) => {
      const before = tree.read('base', path);
      const after = tree.read('head', path);
      if (before === undefined || after === undefined) return before !== after;
      return withoutDocsLine(before) !== withoutDocsLine(after);
    });
  });
}

/** The commits to compare: `undefined` when there's nothing to check. */
function sides(args, git) {
  if (process.env.GITHUB_ACTIONS === 'true') {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8'));
    const eventName = process.env.GITHUB_EVENT_NAME ?? '';
    const between = eventName === 'pull_request' ? range(eventName, event) : undefined;
    if (between === undefined) return undefined;
    return { base: git('merge-base', between.base, between.head).trim(), head: between.head };
  }
  return { base: git('merge-base', args[0] ?? 'origin/main', 'HEAD').trim(), head: 'HEAD' };
}

function main(args) {
  const git = (...gitArgs) =>
    execFileSync('git', gitArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  const between = sides(args, git);
  if (between === undefined) {
    console.log(`${NAME}: not a pull request: nothing to check`);
    return 0;
  }
  const rev = (side) => between[side];
  const tree = {
    read: (side, path) => {
      try {
        return git('show', `${rev(side)}:${path}`);
      } catch {
        return undefined;
      }
    },
    list: (side, dir) =>
      git('ls-tree', '-r', '--name-only', rev(side), '--', dir)
        .split('\n')
        .filter((line) => line !== ''),
  };
  const changed = git('diff', '--name-only', `${between.base}..${between.head}`, '--', SKILLS)
    .split('\n')
    .filter((line) => line !== '');
  const missing = unbumped(changed, tree);
  if (missing.length === 0) {
    const skills = new Set(changed.map(skillOf).filter((name) => name !== undefined)).size;
    console.log(`${NAME}: ok (${skills} skill${skills === 1 ? '' : 's'} changed)`);
    return 0;
  }
  for (const name of missing) {
    console.error(
      `${NAME}: ${SKILLS}${name}/ changed, but its version in ${ENTRY} didn't: bump it`,
    );
  }
  return 1;
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
