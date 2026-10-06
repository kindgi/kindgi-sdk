// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Tests for `scripts/hooks/pre-push`: it runs the clone's
 * `kindgi.prePushCheck` program, passing the push's arguments and stdin,
 * and does nothing without one. Run: `pnpm run test:scripts`.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'hooks', 'pre-push');

const root = mkdtempSync(join(tmpdir(), 'pre-push-'));
after(() => rmSync(root, { recursive: true, force: true }));
execFileSync('git', ['init', '--quiet', root]);

const run = (stdin = '') =>
  spawnSync(HOOK, ['origin', 'https://example.com/acme.git'], {
    cwd: root,
    input: stdin,
    encoding: 'utf8',
  });
const setCheck = (value) =>
  value === undefined
    ? spawnSync('git', ['config', '--unset', 'kindgi.prePushCheck'], { cwd: root })
    : execFileSync('git', ['config', 'kindgi.prePushCheck', value], { cwd: root });

describe('scripts/hooks/pre-push', () => {
  test('no check configured: nothing to do', () => {
    setCheck(undefined);
    assert.equal(run().status, 0);
  });

  test("the check gets the hook's arguments and stdin, and its exit decides", () => {
    const check = join(root, 'check.sh');
    writeFileSync(check, '#!/bin/sh\necho "args: $*" >&2\ncat >&2\nexit 3\n');
    chmodSync(check, 0o755);
    setCheck(check);
    const result = run('refs/heads/a 1 refs/heads/a 0\n');
    assert.equal(result.status, 3);
    assert.match(result.stderr, /args: origin https:\/\/example\.com\/acme\.git/);
    assert.match(result.stderr, /refs\/heads\/a 1 refs\/heads\/a 0/);
  });

  test('a check that is configured but missing stops the push, saying so', () => {
    setCheck(join(root, 'gone.mjs'));
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /names .*gone\.mjs, which isn't there or can't run/);
  });
});
