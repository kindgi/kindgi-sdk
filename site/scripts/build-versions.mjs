#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * Builds the public docs site, every released version of it, ready to
 * deploy:
 *
 *   /            the latest release line (indexed by search engines)
 *   /vX.Y/       every release line, from its newest `@kindgi/sdk@X.Y.*` tag
 *   /versions.json   the list the version menu reads
 *
 * Only releases are public: readers install a release, so the site
 * describes what they have. What's merged but not released is checked in a
 * private preview instead (`build-preview.mjs`).
 *
 * A release line is built from its own tag, in a temporary worktree, so its
 * docs, its generated reference and its code are the same commit. Only tags
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

/** `X.Y.Z[-pre]` → comparable parts; prereleases sort before their release. */
function parse(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(version);
  if (!m) return undefined;
  return { line: `${m[1]}.${m[2]}`, nums: [+m[1], +m[2], +m[3]], pre: m[4] };
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] - b.nums[i];
  if (a.pre === b.pre) return 0;
  if (a.pre === undefined) return 1;
  if (b.pre === undefined) return -1;
  return a.pre.localeCompare(b.pre, undefined, { numeric: true });
}

/** The newest tag of each release line that contains the site, newest line first. */
function releaseLines() {
  const tags = execFileSync('git', ['tag', '--list', '@kindgi/sdk@*'], {
    cwd: repo,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  const newest = new Map();
  for (const tag of tags) {
    const parsed = parse(tag.slice('@kindgi/sdk@'.length));
    if (!parsed) continue;
    const has = spawnSync('git', ['cat-file', '-e', `${tag}:site/package.json`], { cwd: repo });
    if (has.status !== 0) continue;
    const current = newest.get(parsed.line);
    if (!current || compare(parsed, current.parsed) > 0) newest.set(parsed.line, { tag, parsed });
  }
  return [...newest.values()].sort((a, b) => compare(b.parsed, a.parsed));
}

/** Builds the docs of `dir` (a checkout, its workspace built) under `base`; copies them to `dest`. */
function buildDocs(dir, base, ref, dest) {
  run('pnpm', ['run', 'docs:build'], dir, { KINDGI_DOCS_BASE: base, KINDGI_DOCS_REF: ref });
  cpSync(join(dir, 'site', 'dist'), dest, { recursive: true });
}

rmSync(out, { recursive: true, force: true });
const lines = releaseLines();
const versions = [];

if (lines.length === 0) {
  console.error(
    'build-versions: no release contains the site yet. To look at this checkout, use `pnpm run docs:preview`.',
  );
  process.exit(1);
}
const latest = lines[0].parsed.line;
for (const [i, { tag, parsed }] of lines.entries()) {
  console.log(`build-versions: v${parsed.line} from ${tag}`);
  const worktree = mkdtempSync(join(tmpdir(), `kindgi-docs-${parsed.line}-`));
  run('git', ['worktree', 'add', '--detach', worktree, tag], repo);
  try {
    run('pnpm', ['install', '--frozen-lockfile'], worktree);
    run('pnpm', ['run', 'build'], worktree);
    buildDocs(worktree, `/v${parsed.line}/`, tag, join(out, `v${parsed.line}`));
    if (i === 0) buildDocs(worktree, '/', tag, out);
  } finally {
    run('git', ['worktree', 'remove', '--force', worktree], repo);
  }
  versions.push({ version: parsed.line, path: i === 0 ? '/' : `/v${parsed.line}/` });
  if (i === 0) versions.push({ version: parsed.line, path: `/v${parsed.line}/` });
}
writeFileSync(join(out, 'versions.json'), `${JSON.stringify({ latest, versions }, null, 2)}\n`);
console.log(`build-versions: ${out}`);
