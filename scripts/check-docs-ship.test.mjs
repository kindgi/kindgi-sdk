// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Tests for `scripts/check-docs-ship.mjs`, run in a scratch git repository
 * whose branch leaves `main` with one commit. Run: `pnpm run test:scripts`.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./check-docs-ship.mjs', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'kindgi-check-docs-ship-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const CONTRACT = 'packages/cli/src/commands/acme.ts';

function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

let repos = 0;
/** A repository whose branch leaves `main` with one commit of `files`. */
function branch(files, message = 'a change') {
  const root = join(scratch, `repo-${repos++}`);
  mkdirSync(root);
  const git = (...args) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Acme Dev');
  git('config', 'user.email', 'dev@acme.example');
  write(root, { 'README.md': '# Acme\n' });
  git('add', '-A');
  git('commit', '-q', '-m', 'the base');
  git('checkout', '-q', '-b', 'change');
  write(root, files);
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return root;
}

const run = (root) =>
  spawnSync(process.execPath, [SCRIPT, 'main'], { cwd: root, encoding: 'utf8' });

describe('check-docs-ship', () => {
  test('a branch that changes no contract passes', () => {
    const result = run(branch({ 'scripts/acme.mjs': 'export {};\n' }));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no public contract changed/);
  });

  test('a contract changed with no docs fails, naming the contract', () => {
    const result = run(branch({ [CONTRACT]: 'export {};\n' }));
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /changes a public contract but no docs:\n {2}packages\/cli\/src\/commands\/acme\.ts/,
    );
  });

  test('a page, a reference entry, a skill, a README or the contributor docs are its docs', () => {
    for (const docs of [
      'site/src/content/docs/guides/acme.md',
      'site/scripts/reference/entries/errors.mjs',
      'packages/sdk/skills/acme/SKILL.md',
      'packages/cli/README.md',
      'docs/ACME.md',
    ]) {
      const result = run(branch({ [CONTRACT]: 'export {};\n', [docs]: 'words\n' }));
      assert.equal(result.status, 0, `${docs}: ${result.stderr}`);
      assert.match(result.stdout, /1 contract file\(s\) changed, with docs/, docs);
    }
  });

  test("the reference's builders are code, not docs", () => {
    const result = run(
      branch({ [CONTRACT]: 'export {};\n', 'site/scripts/reference/errors.mjs': 'export {};\n' }),
    );
    assert.equal(result.status, 1);
  });

  test('a No-docs: line in a commit message lets a contract change through', () => {
    const result = run(
      branch({ [CONTRACT]: 'export {};\n' }, 'a refactor\n\nNo-docs: nothing users see changes'),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No-docs: nothing users see changes/);
  });
});
