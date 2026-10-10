// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * changed-paths: the patterns, each event's range, and failing open, against
 * a stand-in git and a real one.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { changedFiles, decide, matches, range } from './changed-paths.mjs';

const JVM = ['sdks/java/**', 'packages/api/openapi.json', '.github/workflows/java.yml'];
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('changed-paths', () => {
  test('a pattern is a directory or a file, never a prefix of a name', () => {
    assert.equal(matches('sdks/java/pom.xml', JVM), true);
    assert.equal(matches('sdks/java/kindgi-pack/src/Main.java', JVM), true);
    assert.equal(matches('packages/api/openapi.json', JVM), true);
    assert.equal(matches('sdks/javascript/index.ts', JVM), false);
    assert.equal(matches('packages/api/openapi.json.bak', JVM), false);
    assert.equal(matches('site/src/content/docs/start/java-app.md', JVM), false);
  });

  test("each event's range: a pull request against its base's merge base, a group and a push commit to commit", () => {
    assert.deepEqual(
      range('pull_request', { pull_request: { base: { sha: A }, head: { sha: B } } }),
      {
        base: A,
        head: B,
        mergeBase: true,
      },
    );
    assert.deepEqual(range('merge_group', { merge_group: { base_sha: A, head_sha: B } }), {
      base: A,
      head: B,
      mergeBase: false,
    });
    assert.deepEqual(range('push', { before: A, after: B }), {
      base: A,
      head: B,
      mergeBase: false,
    });
  });

  test('nothing to compare (a manual run, a new branch, an unknown event): everything counts', () => {
    const git = () => assert.fail('git is not asked');
    for (const [eventName, event] of [
      ['workflow_dispatch', {}],
      ['push', { before: '0'.repeat(40), after: B }],
      ['schedule', {}],
      ['pull_request', { pull_request: {} }],
    ]) {
      assert.equal(decide(JVM, { eventName, event, git }).changed, true, eventName);
    }
  });

  test("a diff git can't make counts as changed", () => {
    const result = decide(JVM, {
      eventName: 'merge_group',
      event: { merge_group: { base_sha: A, head_sha: B } },
      git: () => {
        throw new Error('fatal: bad object');
      },
    });
    assert.equal(result.changed, true);
    assert.match(result.why, /can't diff/);
  });

  test('the files that match decide, and are listed', () => {
    const run = (files) => ({
      eventName: 'push',
      event: { before: A, after: B },
      git: (args) => {
        assert.deepEqual(args, ['diff', '--name-only', `${A}..${B}`]);
        return `${files.join('\n')}\n`;
      },
    });
    assert.deepEqual(decide(JVM, run(['README.txt', 'site/x.txt'])), {
      changed: false,
      why: 'none of 2 changed files match',
      files: [],
    });
    assert.deepEqual(decide(JVM, run(['README.md', 'sdks/java/pom.xml'])), {
      changed: true,
      why: '1 of 2 changed files match',
      files: ['sdks/java/pom.xml'],
    });
  });

  test('against a real repository: the merge base for a pull request, so main moving on adds nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'changed-paths-'));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const git = (args) =>
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
        cwd: dir,
        encoding: 'utf8',
      });
    const commit = (path, message) => {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), message);
      git(['add', '-A']);
      git(['commit', '-q', '-m', message]);
      return git(['rev-parse', 'HEAD']).trim();
    };
    git(['init', '-q', '-b', 'main']);
    commit('README.md', 'start');
    git(['checkout', '-q', '-b', 'feature']);
    const head = commit('site/page.txt', 'docs only');
    git(['checkout', '-q', 'main']);
    const base = commit('sdks/java/pom.xml', 'main moves on, in the JVM paths');
    assert.deepEqual(changedFiles({ base, head, mergeBase: true }, git), ['site/page.txt']);
    assert.equal(
      decide(JVM, {
        eventName: 'pull_request',
        event: { pull_request: { base: { sha: base }, head: { sha: head } } },
        git,
      }).changed,
      false,
    );
  });
});
