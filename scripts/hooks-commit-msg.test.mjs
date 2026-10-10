// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Tests for `scripts/hooks/commit-msg`: it checks the message as a pull
 * request's text is checked (`check-pr-text.mjs --message`), so a commit
 * that would be refused once pushed is refused before it exists. Run:
 * `pnpm run test:scripts`.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'hooks', 'commit-msg');

const root = mkdtempSync(join(tmpdir(), 'commit-msg-'));
after(() => rmSync(root, { recursive: true, force: true }));
execFileSync('git', ['init', '--quiet', root]);

/** An internal reference, assembled from parts so the repository's own checks don't flag this file. */
const ref = (...parts) => parts.join('');

const run = (message, env = process.env) => {
  const file = join(root, 'COMMIT_EDITMSG');
  writeFileSync(file, message);
  return spawnSync(HOOK, [file], { cwd: root, encoding: 'utf8', env });
};

describe('scripts/hooks/commit-msg', () => {
  test('a clean message passes, its comment lines aside', () => {
    const result = run(`fix: the retry waits\n\n# On branch fix/${ref('T', 292)}\n`);
    assert.equal(result.status, 0, result.stderr);
  });

  test('an internal reference stops the commit, naming the line', () => {
    const result = run(`fix: the retry waits\n\nas agreed (${ref('protocol ', 16)})\n`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /the commit message, line 3: internal process rule/);
  });

  test('a revert of a commit with one is refused, with a hint to reword it', () => {
    const result = run(`Revert "fix: the retry (${ref('T', 292)})"\n\nThis reverts commit abc.\n`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /the commit message, line 1: internal tracking id/);
    assert.match(
      result.stderr,
      /A revert of a commit whose subject has one: say what it reverts in words/,
    );
  });

  test("without node on PATH, the message isn't checked here, and the hook says so", () => {
    const empty = join(root, 'no-node-bin');
    mkdirSync(empty, { recursive: true });
    const result = run(`fix: one (${ref('T', 292)})\n`, { ...process.env, PATH: empty });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /node isn't on PATH, so this message isn't checked here/);
  });

  test("it reads git's comment character", () => {
    execFileSync('git', ['config', 'core.commentChar', ';'], { cwd: root });
    after(() => spawnSync('git', ['config', '--unset', 'core.commentChar'], { cwd: root }));
    assert.equal(run(`fix: one\n\n; On branch fix/${ref('T', 292)}\n`).status, 0);
    assert.equal(run(`fix: one\n\n# not a comment now: ${ref('T', 292)}\n`).status, 1);
  });
});
