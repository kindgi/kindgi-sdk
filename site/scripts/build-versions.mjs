#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * Builds the public docs site, every released version of it, ready to
 * deploy:
 *
 *   /            the newest release (indexed by search engines)
 *   /vX.Y.Z/     every release, from its `@kindgi/sdk@X.Y.Z` tag (not indexed;
 *                any but the newest shows a banner pointing at the newest)
 *   /vX.Y/       redirects to its line's newest release, page for page
 *                (`/_redirects`)
 *   /next/       the newest pre-release (`@kindgi/sdk@0.1.4-rc.0`) while it's
 *                newer than every release: marked as a release candidate,
 *                never indexed, and gone once its release ships
 *   /versions.json   the list the version menu and the banner read: each build
 *                    with the exact release it's from (`0.1.3`, `0.1.4-rc.3`)
 *
 * Only releases are public: readers install a release, so the site
 * describes what they have. What's merged but not released is checked in a
 * private preview instead (`build-preview.mjs`).
 *
 * A release is built from its own tag, in a temporary worktree, so its docs,
 * its generated reference and its code are the same commit. Only tags
 * that contain the site count (releases before it have no docs to build).
 *
 * Usage: node site/scripts/build-versions.mjs [--out <dir>]
 *   --out            where to write the site (default: site/dist-versions)
 *
 * Needs git, pnpm and uv, and this checkout's workspace built (`pnpm run build`).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { menu, plan, redirects } from './versions-plan.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const out = resolve(option('--out') ?? join(repo, 'site', 'dist-versions'));

function run(command, commandArgs, cwd, env = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} failed in ${cwd}`);
  }
}

/** The `@kindgi/sdk@*` tags that contain the site. */
function siteTags() {
  return execFileSync('git', ['tag', '--list', '@kindgi/sdk@*'], { cwd: repo, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((tag) => {
      const site = spawnSync('git', ['cat-file', '-e', `${tag}:site/package.json`], { cwd: repo });
      return site.status === 0;
    });
}

/** Builds the docs of `dir` (a checkout, its workspace built) under `base`; copies them to `dest`. */
function buildDocs(dir, base, ref, dest) {
  run('pnpm', ['run', 'docs:build'], dir, { KINDGI_DOCS_BASE: base, KINDGI_DOCS_REF: ref });
  cpSync(join(dir, 'site', 'dist'), dest, { recursive: true });
}

rmSync(out, { recursive: true, force: true });
const planned = plan(siteTags());
const { releases, next } = planned;

if (releases.length === 0) {
  console.error(
    'build-versions: no release contains the site yet. To look at this checkout, use `pnpm run docs:preview`.',
  );
  process.exit(1);
}
/** Checks out `tag` in a temporary worktree, builds its workspace, and runs `build` in it. */
function atTag(tag, name, build) {
  const worktree = mkdtempSync(join(tmpdir(), `kindgi-docs-${name}-`));
  run('git', ['worktree', 'add', '--detach', worktree, tag], repo);
  try {
    run('pnpm', ['install', '--frozen-lockfile'], worktree);
    run('pnpm', ['run', 'build'], worktree);
    build(worktree);
  } finally {
    run('git', ['worktree', 'remove', '--force', worktree], repo);
  }
}
for (const [i, { tag, parsed }] of releases.entries()) {
  console.log(`build-versions: v${parsed.version} from ${tag}`);
  atTag(tag, parsed.version, (worktree) => {
    if (i === 0) buildDocs(worktree, '/', tag, out);
    buildDocs(worktree, `/v${parsed.version}/`, tag, join(out, `v${parsed.version}`));
  });
}
if (next) {
  console.log(`build-versions: next (v${next.parsed.version}) from ${next.tag}`);
  atTag(next.tag, 'next', (worktree) => buildDocs(worktree, '/next/', next.tag, join(out, 'next')));
}
writeFileSync(join(out, 'versions.json'), `${JSON.stringify(menu(planned), null, 2)}\n`);
writeFileSync(join(out, '_redirects'), redirects(planned));
console.log(`build-versions: ${out}`);
