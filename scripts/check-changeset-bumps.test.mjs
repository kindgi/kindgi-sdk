// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `scripts/check-changeset-bumps.mjs`: before 1.0, or while release
 * candidates are out, a `minor` or `major` changeset needs a
 * `Release-decision:` line.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { bumpProblems, changesetBumps, whyDecisionNeeded } from './check-changeset-bumps.mjs';

const SCRIPT = fileURLToPath(new URL('./check-changeset-bumps.mjs', import.meta.url));
/** A changeset's file name, built so check-refs doesn't read it as a document reference. */
const md = (name) => `${name}.md`;
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
        { file: md('a'), text: changeset({ '@kindgi/api': 'minor', '@kindgi/cli': 'patch' }) },
        { file: md('b'), text: changeset({ '@kindgi/cli': 'patch' }) },
        { file: md('c'), text: changeset({ '@kindgi/sdk': 'major' }) },
      ]),
      [`${md('a')}: @kindgi/api: minor`, `${md('c')}: @kindgi/sdk: major`],
    );
  });

  test('a Release-decision line lets it through', () => {
    const decided = changeset(
      { '@kindgi/api': 'minor' },
      'A new surface.\n\nRelease-decision: 0.2.0, the maintainers, 2026-10-06',
    );
    assert.deepEqual(bumpProblems([{ file: md('a'), text: decided }]), []);
  });
});

describe('whyDecisionNeeded', () => {
  test('before 1.0, always; from 1.0, only in pre mode', () => {
    assert.match(whyDecisionNeeded({ version: '0.1.3' }), /before 1\.0/);
    assert.match(
      whyDecisionNeeded({ version: '0.1.4-rc.0', pre: { mode: 'pre', tag: 'rc' } }),
      /pre mode/,
    );
    assert.equal(whyDecisionNeeded({ version: '1.2.0' }), undefined);
    assert.equal(
      whyDecisionNeeded({ version: '1.2.0', pre: { mode: 'exit', tag: 'rc' } }),
      undefined,
    );
    assert.match(
      whyDecisionNeeded({ version: '1.3.0-rc.1', pre: { mode: 'pre', tag: 'rc' } }),
      /pre mode/,
    );
  });
});

describe('the command', () => {
  const dirs = [];
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const repo = (files, version = '0.1.3') => {
    const root = mkdtempSync(join(tmpdir(), 'kindgi-changesets-'));
    dirs.push(root);
    mkdirSync(join(root, '.changeset'));
    mkdirSync(join(root, 'packages', 'sdk'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'sdk', 'package.json'),
      JSON.stringify({ name: '@kindgi/sdk', version }),
    );
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(root, '.changeset', name), text);
    }
    return root;
  };
  const run = (cwd) => spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' });

  test('before 1.0, a minor fails even outside pre mode', () => {
    const out = run(repo({ [md('a')]: changeset({ '@kindgi/api': 'minor' }) }));
    assert.equal(out.status, 1);
    assert.match(out.stderr, /before 1\.0/);
    assert.match(out.stderr, /\.changeset\/a\.md: @kindgi\/api: minor/);
  });

  test('from 1.0, outside pre mode, a minor passes', () => {
    const out = run(repo({ [md('a')]: changeset({ '@kindgi/api': 'minor' }) }, '1.2.0'));
    assert.equal(out.status, 0);
    assert.match(out.stdout, /need no decision/);
  });

  test('in pre mode, a minor fails, naming it', () => {
    const out = run(
      repo({
        'pre.json': JSON.stringify({ mode: 'pre', tag: 'rc' }),
        [md('a')]: changeset({ '@kindgi/api': 'minor' }),
        [md('b')]: changeset({ '@kindgi/cli': 'patch' }),
        'README.md': '# Changesets\n',
      }),
    );
    assert.equal(out.status, 1);
    assert.match(out.stderr, /\.changeset\/a\.md: @kindgi\/api: minor/);
    assert.doesNotMatch(out.stderr, /b\.md/);
  });

  test('in pre mode, patches pass; after pre exit (from 1.0), a minor passes', () => {
    assert.equal(
      run(
        repo({
          'pre.json': JSON.stringify({ mode: 'pre', tag: 'rc' }),
          [md('b')]: changeset({ '@kindgi/cli': 'patch' }),
        }),
      ).status,
      0,
    );
    assert.equal(
      run(
        repo(
          {
            'pre.json': JSON.stringify({ mode: 'exit', tag: 'rc' }),
            [md('a')]: changeset({ '@kindgi/api': 'minor' }),
          },
          '1.2.0',
        ),
      ).status,
      0,
    );
  });
});
