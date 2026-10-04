#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * CI on the developer's machine, reported to GitHub as the `local-ci`
 * commit status. GitHub's own CI runs only the quick "Lint + border +
 * specs" job on pull requests; this script runs that job's steps and
 * everything the other two jobs ran (`.github/workflows/ci.yml`: "Build +
 * typecheck + test + publish checks" and "Python SDK" on 3.11 and 3.13)
 * on the pushed commit:
 *
 *   - refuses a working tree with changes or untracked files, so the
 *     result is about the commit, not the checkout;
 *   - requires that commit to be pushed (a status can only be posted on a
 *     commit GitHub has);
 *   - waits for a slot in the machine-wide queue (`local-ci-queue.mjs`: at
 *     most two runs at once across every checkout), posting "queued" while
 *     it waits;
 *   - posts `local-ci: pending`, runs the steps in order (stopping at the
 *     first failure), then posts success or failure, with the failed step.
 *
 * Needs pnpm, uv and Docker (the pack conformance suite).
 *
 * Usage: `pnpm run ci:local [--no-post]`
 *   --no-post  run the steps without posting a status
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireSlot, recordRun } from './local-ci-queue.mjs';

const post = !process.argv.slice(2).includes('--no-post');
const CONTEXT = 'local-ci';

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();

function fail(message) {
  console.error(`\nlocal-ci: ${message}`);
  process.exit(1);
}

// ---- preconditions -------------------------------------------------------

if (git('status', '--porcelain') !== '') {
  fail('the working tree has changes or untracked files; commit or clean them first.');
}
const sha = git('rev-parse', 'HEAD');
const slug = git('remote', 'get-url', 'origin')
  .replace(/^.*github\.com[:/]/, '')
  .replace(/\.git$/, '');
if (post) {
  const pushed = spawnSync('gh', ['api', `repos/${slug}/commits/${sha}`, '--silent'], {
    stdio: 'ignore',
  });
  if (pushed.status !== 0) fail(`${sha.slice(0, 8)} isn't on GitHub yet; push it, then run again.`);
}

function setStatus(state, description) {
  if (!post) return;
  execFileSync(
    'gh',
    [
      'api',
      '--silent',
      '-X',
      'POST',
      `repos/${slug}/statuses/${sha}`,
      '-f',
      `state=${state}`,
      '-f',
      `context=${CONTEXT}`,
      '-f',
      `description=${description.slice(0, 140)}`,
    ],
    { stdio: 'inherit' },
  );
}

// ---- the steps -----------------------------------------------------------

// Scratch space outside the checkout: the dependency-floors environments
// and the built distribution.
const scratch = mkdtempSync(join(tmpdir(), 'kindgi-local-ci-'));
const floorsNode = join(scratch, 'floors-node');
const floorsPython = join(scratch, 'floors-python');
const dist = join(scratch, 'dist');
const py = { cwd: 'sdks/python' };

/** One Python version's CI job (`python` in ci.yml). */
const pythonJob = (version) => [
  [`python ${version}: environment`, 'uv', ['sync', '--frozen', '--python', version], py],
  [
    `python ${version}: ruff`,
    'bash',
    ['-c', 'uv run ruff check src tests scripts && uv run ruff format --check src tests scripts'],
    py,
  ],
  [`python ${version}: pyright`, 'uv', ['run', 'pyright'], py],
  [`python ${version}: pytest`, 'uv', ['run', 'pytest'], py],
];

const steps = [
  // "Lint + border + specs"
  ['install', 'pnpm', ['install', '--frozen-lockfile']],
  ['lint', 'pnpm', ['run', 'lint']],
  ['border', 'pnpm', ['run', 'check:border']],
  ['headers', 'pnpm', ['run', 'check:headers']],
  ['references', 'pnpm', ['run', 'check:refs']],
  ['docs ship with the change', 'pnpm', ['run', 'check:docs-ship']],
  ['README package table', 'pnpm', ['run', 'check:readme']],
  ['JSON Schemas', 'pnpm', ['run', 'spec:validate']],
  // "Build + typecheck + test + publish checks"
  ['Python SDK environment', 'uv', ['sync', '--project', 'sdks/python', '--frozen']],
  ['build', 'pnpm', ['run', 'build']],
  ['typecheck', 'pnpm', ['run', 'typecheck:all']],
  ['test', 'pnpm', ['run', 'test:all']],
  [
    'pack conformance at the Python dependency floors',
    'bash',
    [
      '-c',
      `uv venv ${floorsNode} && uv pip install --python ${floorsNode} --resolution lowest-direct -e sdks/python && KINDGI_CONFORMANCE_PYTHON=${floorsNode}/bin/python pnpm --filter @kindgi/pack-conformance exec vitest run tests/python.test.ts tests/python-supervisor.test.ts`,
    ],
  ],
  ['publish readiness', 'pnpm', ['run', 'check:publish']],
  // The documentation site (docs.kindgi.com) builds, with its search index.
  ['docs site', 'pnpm', ['run', 'docs:build']],
  // Every sample that is a whole file compiles (TypeScript) or indexes (Python).
  ['docs samples', 'pnpm', ['run', 'docs:samples']],
  // Every tutorial step that needs no model runs as written, against this
  // checkout's CLI and the runtime image it pins (needs Docker).
  ['docs tutorials', 'pnpm', ['run', 'docs:tutorials']],
  // "Python SDK (3.11)" and "(3.13)"
  ...pythonJob('3.11'),
  [
    'python 3.11: pytest at the dependency floors',
    'bash',
    [
      '-c',
      `uv venv ${floorsPython} --python 3.11 && uv pip install --python ${floorsPython} --resolution lowest-direct -e . "pytest>=8" && ${floorsPython}/bin/python -m pytest -p no:cacheprovider -k "not in_step_with_openapi"`,
    ],
    py,
  ],
  ...pythonJob('3.13'),
  [
    'generated client in step with openapi.json',
    'uv',
    ['run', 'python', 'scripts/gen_client.py', '--check'],
    py,
  ],
  [
    'the distribution builds, with core metadata 2.3',
    'bash',
    [
      '-c',
      `uv build --out-dir ${dist} && unzip -p ${dist}/*.whl '*.dist-info/METADATA' | grep -qx 'Metadata-Version: 2.3'`,
    ],
    py,
  ],
];

const host = hostname().split('.')[0];

const { waitedMs } = acquireSlot({
  repo: slug,
  sha,
  onWait: (holders) => {
    setStatus('pending', `queued on ${host}: waiting for a local-ci slot`);
    console.log(`local-ci: waiting for a slot (running: ${holders.join(', ') || 'starting'})`);
  },
});
const started = Date.now();
const minutes = () => `${Math.max(1, Math.round((Date.now() - started) / 60_000))} min`;
const waited = waitedMs >= 60_000 ? `, after waiting ${Math.round(waitedMs / 60_000)} min` : '';

setStatus('pending', `running on ${host}`);
console.log(`local-ci: ${sha.slice(0, 8)} on ${host}${waited}`);

let failed;
for (const [name, cmd, cmdArgs, options] of steps) {
  console.log(`\n▶ ${name}`);
  const t = Date.now();
  const result = spawnSync(cmd, cmdArgs, { stdio: 'inherit', ...options });
  if (result.status !== 0) {
    failed = name;
    break;
  }
  console.log(`✓ ${name} (${Math.round((Date.now() - t) / 1000)} s)`);
}
rmSync(scratch, { recursive: true, force: true });
recordRun({
  repo: slug,
  sha,
  waitedS: Math.round(waitedMs / 1000),
  durationS: Math.round((Date.now() - started) / 1000),
  result: failed === undefined ? 'passed' : `failed: ${failed}`,
});
if (failed !== undefined) {
  setStatus('failure', `failed at: ${failed} (${host}, after ${minutes()})`);
  fail(`failed at: ${failed}`);
}

setStatus('success', `${steps.length} steps passed on ${host} in ${minutes()}`);
console.log(`\nlocal-ci: passed in ${minutes()}${post ? ' — posted to GitHub' : ''}`);
