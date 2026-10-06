// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `scripts/check-changeset-bumps.mjs`: in pre mode, a `minor` or `major`
 * changeset needs a `Release-decision:` line.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { bumpProblems, changesetBumps } from './check-changeset-bumps.mjs';

const SCRIPT = fileURLToPath(new URL('./check-changeset-bumps.mjs', import.meta.url));
const changeset = (bumps, body = 'A change.') =>
  `---\n${Object.entries(bumps)
    .map(([pkg, bump]) => `"${pkg}": ${bump}`)
    .join('\n')}\n---\n\n${body}\n`;

describe('changesetBumps', () => {
  test('reads each package and its bump from the front matter', () => {
    assert.deepEqual(
      changesetBumps(changeset({ '@kindgi/api': 'minor', '@kindgi/cli': 'patch' })),
      [
        { pkg: '@kindgi/api', bump: 'minor' },
        { pkg: '@kindgi/cli', bump: 'patch' },
      ],
    );
    assert.deepEqual(changesetBumps("---\n'@kindgi/sdk': major\n---\n"), [
      { pkg: '@kindgi/sdk', bump: 'major' },
    ]);
    assert.deepEqual(changesetBumps('no front matter'), []);
  });
});

describe('bumpProblems', () => {
  test('a minor or major is a problem; a patch is not', () => {
    assert.deepEqual(
      bumpProblems([
        { file: 'a.md', text: changeset({ '@kindgi/api': 'minor', '@kindgi/cli': 'patch' }) },
        { file: 'b.md', text: changeset({ '@kindgi/cli': 'patch' }) },
        { file: 'c.md', text: changeset({ '@kindgi/sdk': 'major' }) },
      ]),
      ['a.md: @kindgi/api: minor', 'c.md: @kindgi/sdk: major'],
    );
  });

  test('a Release-decision line lets it through', () => {
    const decided = changeset(
      { '@kindgi/api': 'minor' },
      'A new surface.\n\nRelease-decision: 0.2.0, Katrin, 2026-10-06',
    );
    assert.deepEqual(bumpProblems([{ file: 'a.md', text: decided }]), []);
  });
});

describe('the command', () => {
  const dirs = [];
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const repo = (files) => {
    const root = mkdtempSync(join(tmpdir(), 'kindgi-changesets-'));
    dirs.push(root);
    mkdirSync(join(root, '.changeset'));
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(root, '.changeset', name), text);
    }
    return root;
  };
  const run = (cwd) => spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' });

  test('outside pre mode, a minor passes', () => {
    const out = run(repo({ 'a.md': changeset({ '@kindgi/api': 'minor' }) }));
    assert.equal(out.status, 0);
    assert.match(out.stdout, /not in pre mode/);
  });

  test('in pre mode, a minor fails, naming it', () => {
    const out = run(
      repo({
        'pre.json': JSON.stringify({ mode: 'pre', tag: 'rc' }),
        'a.md': changeset({ '@kindgi/api': 'minor' }),
        'b.md': changeset({ '@kindgi/cli': 'patch' }),
        'README.md': '# Changesets\n',
      }),
    );
    assert.equal(out.status, 1);
    assert.match(out.stderr, /\.changeset\/a\.md: @kindgi\/api: minor/);
    assert.doesNotMatch(out.stderr, /b\.md/);
  });

  test('in pre mode, patches pass; after pre exit, a minor passes', () => {
    assert.equal(
      run(
        repo({
          'pre.json': JSON.stringify({ mode: 'pre', tag: 'rc' }),
          'b.md': changeset({ '@kindgi/cli': 'patch' }),
        }),
      ).status,
      0,
    );
    assert.equal(
      run(
        repo({
          'pre.json': JSON.stringify({ mode: 'exit', tag: 'rc' }),
          'a.md': changeset({ '@kindgi/api': 'minor' }),
        }),
      ).status,
      0,
    );
  });
});
