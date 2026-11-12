// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
// reads-source: none

/**
 * Tests for `scripts/sync-cli-line.mjs` and `scripts/check-cli-line.mjs`,
 * the commands, in a scratch repository: the check names what's off the
 * line, the sync moves it in exactly scripts/lib/cli-line.mjs's files, and
 * the check then passes. Run: `pnpm run test:scripts`.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { scratchRepoEnv } from './lib/git-env.mjs';

const SYNC = fileURLToPath(new URL('./sync-cli-line.mjs', import.meta.url));
const CHECK = fileURLToPath(new URL('./check-cli-line.mjs', import.meta.url));
/** git's repository variables dropped, so a shell pointing at another repository leaves it alone. */
const scratchEnv = scratchRepoEnv();
const scratch = mkdtempSync(join(tmpdir(), 'kindgi-sync-cli-line-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A path ending in `.md`, spelled so check-refs doesn't take a scratch repository's for this one's. */
const md = (path) => `${path}.md`;
const PAGE = md('site/src/content/docs/start/install');
const NOTES = md('site/src/content/docs/releases/0.2.0');
const SKILL = md('packages/sdk/skills/acme-getting-started/SKILL');
const README = md('packages/cli/README');
const CHANGELOG = md('packages/cli/CHANGELOG');
const DRAFT = md('site/src/content/docs/start/draft');

const AT = (cli, uv, line, client = line) =>
  [
    `Run \`npx --yes @kindgi/cli@${cli} doctor\`, or`,
    `\`uvx --from "kindgi-cli>=${uv}" kindgi doctor\`, with Kindgi ${line}'s CLI.`,
    `A backend takes Kindgi ${client}'s client.`,
    '',
  ].join('\n');
const AT_02 = AT('0.2', '0.2,<0.3', '0.2');
const AT_04 = AT('0.4', '0.4,<0.5', '0.4');

let n = 0;
/** A scratch repository at `cli`'s and `sdk`'s versions, every file tracked unless `untracked` names it. */
function repo({ cli = '0.4.0', sdk = cli, files = {}, untracked = {} } = {}) {
  n += 1;
  const root = join(scratch, `repo-${n}`);
  const write = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  write('packages/cli/package.json', JSON.stringify({ name: '@kindgi/cli', version: cli }));
  write('packages/sdk/package.json', JSON.stringify({ name: '@kindgi/sdk', version: sdk }));
  for (const [file, text] of Object.entries(files)) write(file, text);
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], {
    cwd: root,
    env: scratchEnv,
  });
  execFileSync('git', ['add', '-A'], { cwd: root, env: scratchEnv });
  for (const [file, text] of Object.entries(untracked)) write(file, text);
  return root;
}

const run = (root, script, args = []) =>
  spawnSync(process.execPath, [script, ...args], { cwd: root, env: scratchEnv, encoding: 'utf8' });
const read = (root, file) => readFileSync(join(root, file), 'utf8');

const FILES = {
  [PAGE]: AT_02,
  [SKILL]: AT_02,
  [README]: AT_02,
  [NOTES]: AT_02,
  [CHANGELOG]: AT_02,
};

describe('check-cli-line and sync-cli-line', () => {
  test('the check names each form off the line, the sync moves them, and the check passes', () => {
    const root = repo({ files: FILES, untracked: { [DRAFT]: AT_02 } });
    const before = run(root, CHECK);
    assert.equal(before.status, 1, before.stdout);
    assert.match(
      before.stderr,
      new RegExp(
        `${PAGE.replaceAll('.', '\\.')}:1: @kindgi/cli@0\\.2, where its line is @kindgi/cli@0\\.4`,
      ),
    );
    assert.match(
      before.stderr,
      /:2: kindgi-cli>=0\.2,<0\.3, where its line is kindgi-cli>=0\.4,<0\.5/,
    );
    assert.match(
      before.stderr,
      /check-cli-line: 12 form\(s\) off the line \(@kindgi\/cli 0\.4\.0, @kindgi\/sdk 0\.4\.0\); `node scripts\/sync-cli-line\.mjs` moves them/,
    );

    const result = run(root, SYNC);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(read(root, PAGE), AT_04);
    assert.equal(read(root, SKILL), AT_04);
    assert.equal(read(root, README), AT_04);
    assert.equal(read(root, NOTES), AT_02, 'the release notes are history');
    assert.equal(read(root, CHANGELOG), AT_02, 'a changelog is history');
    assert.equal(read(root, DRAFT), AT_02, 'untracked');
    assert.match(result.stdout, /12 form\(s\) in 3 of 3 file\(s\) moved to their line/);

    const checked = run(root, CHECK);
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /3 file\(s\) read; every form is on its line/);
  });

  test('a second run changes nothing', () => {
    const root = repo({ files: FILES });
    assert.equal(run(root, SYNC).status, 0);
    const again = run(root, SYNC);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /3 file\(s\) read; every form is on its line/);
    assert.equal(read(root, PAGE), AT_04);
  });

  test("a pre-release takes the CLI's exact build, and the client's prose its own line", () => {
    const root = repo({ cli: '0.6.0-rc.1', sdk: '0.6.0-rc.1', files: { [PAGE]: AT_04 } });
    assert.equal(run(root, SYNC).status, 0);
    assert.equal(read(root, PAGE), AT('0.6.0-rc.1', '0.6.0rc1,<0.7', '0.6'));
    assert.equal(run(root, CHECK).status, 0);
  });

  test("the client's prose follows @kindgi/sdk's version", () => {
    const root = repo({ cli: '0.4.0', sdk: '0.5.0', files: { [PAGE]: AT_04 } });
    const checked = run(root, CHECK);
    assert.equal(checked.status, 1);
    assert.match(
      checked.stderr,
      /:3: Kindgi 0\.4's client, where its line is Kindgi 0\.5's client/,
    );
    assert.equal(run(root, SYNC).status, 0);
    assert.equal(read(root, PAGE), AT('0.4', '0.4,<0.5', '0.4', '0.5'));
  });

  test("skips a tracked file that's gone from the checkout", () => {
    const root = repo({ files: FILES });
    unlinkSync(join(root, README));
    const result = run(root, SYNC);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /8 form\(s\) in 2 of 2 file\(s\)/);
  });

  test('refuses an argument, and a version with no line, writing nothing', () => {
    const root = repo({ files: FILES });
    for (const [script, name] of [
      [SYNC, 'sync-cli-line'],
      [CHECK, 'check-cli-line'],
    ]) {
      const extra = run(root, script, ['--release']);
      assert.equal(extra.status, 1);
      assert.match(extra.stderr, new RegExp(`${name}: unknown argument --release; usage:`));
    }

    const bad = repo({ cli: 'next', sdk: '0.4.0', files: FILES });
    for (const script of [SYNC, CHECK]) {
      const refused = run(bad, script);
      assert.equal(refused.status, 1);
      assert.match(
        refused.stderr,
        /packages\/cli\/package\.json has no version a line can come from/,
      );
    }
    assert.equal(read(bad, PAGE), AT_02);
  });

  test("refuses a file with forms to move that isn't UTF-8, and writes no file", () => {
    const root = repo({
      files: {
        // git lists it before the bad file, so it's read, and would be moved, first.
        [PAGE]: AT_02,
        [md('site/src/content/docs/start/zz')]: Buffer.concat([
          Buffer.from(AT_02),
          Buffer.from([0xff, 0xfe]),
        ]),
      },
    });
    const result = run(root, SYNC);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /zz\.md names another line of the CLI but isn't UTF-8 text/);
    assert.equal(read(root, PAGE), AT_02);
  });
});
