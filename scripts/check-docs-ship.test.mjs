// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `scripts/check-docs-ship.mjs`: a pull request that changes a public
 * contract changes the docs or has a `No-docs:` line in a commit of its
 * own, against its base, never through another pull request's commits.
 * Fixture repositories with a local bare origin stand in for GitHub
 * (`refs/pull/<n>/head`), and a stand-in `gh` for `gh pr view`.
 * Run: `pnpm run test:scripts`.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { eventPull, otherHeads, pullHeads, squashedNumbers } from './check-docs-ship.mjs';

const SCRIPT = fileURLToPath(new URL('./check-docs-ship.mjs', import.meta.url));
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

describe('eventPull', () => {
  test("a pull request event's number, base and head; any other event has none", () => {
    assert.deepEqual(
      eventPull({ pull_request: { number: 7, base: { sha: A }, head: { sha: B } } }),
      { number: 7, base: A, head: B },
    );
    assert.equal(eventPull({ merge_group: {} }), undefined);
  });

  test('a pull request event without them is refused, not read as no pull request', () => {
    assert.throws(() => eventPull({ pull_request: { number: 7, head: { sha: B } } }), /base\.sha/);
    assert.throws(() => eventPull({ pull_request: { base: { sha: A }, head: { sha: B } } }));
  });
});

describe('pullHeads', () => {
  test('reads each pull request head, and nothing else', () => {
    assert.deepEqual(
      pullHeads(
        [
          `${A}\trefs/pull/12/head`,
          `${B}\trefs/pull/12/merge`,
          `${C}\trefs/heads/main`,
          `${C}\trefs/pull/3/head`,
          '',
        ].join('\n'),
      ),
      [
        { number: 12, sha: A },
        { number: 3, sha: C },
      ],
    );
  });
});

describe('squashedNumbers', () => {
  test('the numbers subjects end with, as a squash writes them', () => {
    assert.deepEqual(
      squashedNumbers(
        'feat(cli): a change (#12)\nfix: see (#3) above\nMerge main\ndocs: x (#40)  \n',
      ),
      new Set([12, 40]),
    );
  });
});

describe('otherHeads', () => {
  const pull = { number: 5, head: A };
  test('leaves out its own head by number and by commit, and keeps what `keep` keeps', () => {
    const heads = [
      { number: 5, sha: B },
      { number: 6, sha: A },
      { number: 7, sha: C },
      { number: 8, sha: B },
    ];
    assert.deepEqual(
      otherHeads(heads, pull, () => true),
      [
        { number: 7, sha: C },
        { number: 8, sha: B },
      ],
    );
    assert.deepEqual(
      otherHeads(heads, pull, (head) => head.number === 8),
      [{ number: 8, sha: B }],
    );
  });
});

describe('the command', () => {
  const dirs = [];
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  // Neither Actions' event nor a caller's git state reaches the fixtures.
  const ENV = { ...process.env };
  for (const name of [
    'GITHUB_EVENT_PATH',
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GH_REPO',
    'GH_HOST',
  ]) {
    delete ENV[name];
  }
  const CONTRACT = 'packages/cli/src/commands/acme.ts';
  const CONTRACT_2 = 'packages/cli/src/commands/acme-two.ts';
  const PAGE = 'site/src/content/docs/acme.mdx';

  /**
   * A bare origin and two clones of it: `work`, where the check runs, and
   * `elsewhere`, for commits `work` hasn't fetched.
   */
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'check-docs-ship-'));
    dirs.push(root);
    const origin = join(root, 'origin.git');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const run = (cwd, args) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.email=t@example.com',
          '-c',
          'user.name=t',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        { cwd, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] },
      ).trim();
    run(root, ['init', '-q', '--bare', '-b', 'main', origin]);
    const clone = (name) => {
      const dir = join(root, name);
      run(root, ['init', '-q', '-b', 'main', dir]);
      run(dir, ['remote', 'add', 'origin', origin]);
      const git = (...args) => run(dir, args);
      return {
        dir,
        git,
        /** Commit `files` (path → text; none for an empty commit) with `message`. */
        commit(message, files = {}) {
          for (const [path, text] of Object.entries(files)) {
            mkdirSync(dirname(join(dir, path)), { recursive: true });
            writeFileSync(join(dir, path), text);
          }
          git('add', '-A');
          git('commit', '-q', '--allow-empty', '-m', message);
          return git('rev-parse', 'HEAD');
        },
        /** Open (or move) pull request `number` at `sha`. */
        pull(number, sha) {
          git('push', '-q', 'origin', `${sha}:refs/pull/${number}/head`);
        },
      };
    };
    const work = clone('work');
    work.commit('start', { 'README.md': '# acme\n', [CONTRACT]: 'export const a = 1;\n' });
    work.git('push', '-q', 'origin', 'main');
    const f = {
      root,
      work,
      elsewhere() {
        const other = clone('elsewhere');
        other.git('fetch', '-q', 'origin', 'main');
        other.git('reset', '-q', '--hard', 'origin/main');
        return other;
      },
      /** `pull_request` event for `number` with `base` and `head` commits. */
      event(number, base, head) {
        const path = join(root, `event-${number}.json`);
        writeFileSync(
          path,
          JSON.stringify({ pull_request: { number, base: { sha: base }, head: { sha: head } } }),
        );
        return path;
      },
      /** A stand-in `gh` that answers `gh pr view` with `view`, or fails. */
      gh(view) {
        const script = join(bin, 'gh');
        writeFileSync(
          script,
          view === undefined
            ? '#!/bin/sh\necho "no pull requests found for branch" >&2\nexit 1\n'
            : `#!/bin/sh\necho "$@" > "${join(root, 'gh-args')}"\ncat <<'EOF'\n${JSON.stringify(view)}\nEOF\n`,
        );
        chmodSync(script, 0o755);
      },
      check(args = [], env = {}) {
        return spawnSync(process.execPath, [SCRIPT, ...args], {
          cwd: work.dir,
          encoding: 'utf8',
          env: { ...ENV, PATH: `${bin}:${ENV.PATH}`, ...env },
        });
      },
    };
    // No test reaches the real gh: until a test says otherwise, it finds none.
    f.gh(undefined);
    return f;
  };

  test('a squashed stack, retargeted: the squashed line is not its own; a line of its own is', () => {
    const f = fixture();
    const { work } = f;
    work.git('checkout', '-q', '-b', 'train');
    const train = work.commit('the train\n\nNo-docs: the train needs none', {
      [CONTRACT]: 'export const a = 2;\n',
    });
    work.pull(10, train);
    work.git('checkout', '-q', '-b', 'child');
    work.commit('the child', { [CONTRACT_2]: 'export const b = 1;\n' });
    work.git('checkout', '-q', 'main');
    work.git('merge', '-q', '--squash', 'train');
    work.commit('The train (#10)');
    work.git('push', '-q', 'origin', 'main');
    work.git('checkout', '-q', 'child');
    work.git('merge', '-q', '--no-edit', 'main');
    const head = work.git('rev-parse', 'HEAD');
    work.pull(11, head);
    const main = work.git('rev-parse', 'main');

    const failed = f.check(['--event', f.event(11, main, head)]);
    assert.equal(failed.status, 1, failed.stdout);
    assert.match(failed.stderr, /packages\/cli\/src\/commands\/acme-two\.ts/);
    assert.doesNotMatch(failed.stderr, /commands\/acme\.ts/);
    assert.match(
      failed.stderr,
      new RegExp(
        `skipped in ${train.slice(0, 7)} \\(carried by #10\\): No-docs: the train needs none`,
      ),
    );

    const own = work.commit('the child says why\n\nNo-docs: the child needs none');
    work.pull(11, own);
    const passed = f.check(['--event', f.event(11, main, own)]);
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(passed.stdout, new RegExp(`${own.slice(0, 7)}: No-docs: the child needs none`));
  });

  test('never squashed, main merged in twice after its line: the line counts, as before', () => {
    const f = fixture();
    const { work } = f;
    work.git('checkout', '-q', '-b', 'solo');
    const line = work.commit('solo\n\nNo-docs: solo needs none', {
      [CONTRACT]: 'export const a = 3;\n',
    });
    for (const n of [1, 2]) {
      work.git('checkout', '-q', 'main');
      work.commit(`main moves on (#${20 + n})`, { [`notes-${n}.txt`]: `${n}\n` });
      work.git('push', '-q', 'origin', 'main');
      work.git('checkout', '-q', 'solo');
      work.git('merge', '-q', '--no-edit', 'main');
    }
    const head = work.git('rev-parse', 'HEAD');
    work.pull(12, head);
    const out = f.check(['--event', f.event(12, work.git('rev-parse', 'main'), head)]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, new RegExp(`${line.slice(0, 7)}: No-docs: solo needs none`));
  });

  test("stacked on an open pull request: against the event's base, the base's docs don't count", () => {
    const f = fixture();
    const { work } = f;
    work.git('checkout', '-q', '-b', 'base-pr');
    const basePr = work.commit('the base pull request, with its page', {
      [CONTRACT]: 'export const a = 4;\n',
      [PAGE]: '# Acme\n',
    });
    work.pull(20, basePr);
    work.git('checkout', '-q', '-b', 'stacked');
    const head = work.commit('stacked', { [CONTRACT_2]: 'export const b = 2;\n' });
    work.pull(21, head);
    const event = f.event(21, basePr, head);

    // Through GITHUB_EVENT_PATH, as Actions runs it.
    const out = f.check([], { GITHUB_EVENT_PATH: event });
    assert.equal(out.status, 1, out.stdout);
    assert.match(out.stderr, /acme-two\.ts/);
    assert.doesNotMatch(out.stderr, /commands\/acme\.ts/);
    // Against origin/main (as before) the base's page let it through.
    assert.equal(f.check(['origin/main', '--event', event]).status, 0);
  });

  test("in Actions, HEAD is a merge over its own head: its own head isn't another's", () => {
    const f = fixture();
    const { work } = f;
    work.git('checkout', '-q', '-b', 'own');
    const own = work.commit('own\n\nNo-docs: own needs none', {
      [CONTRACT]: 'export const a = 5;\n',
    });
    work.pull(30, own);
    work.git('checkout', '-q', 'main');
    const main = work.commit('main moves on (#29)', { 'notes.txt': 'x\n' });
    work.git('push', '-q', 'origin', 'main');
    work.git('checkout', '-q', '--detach', 'main');
    work.git('merge', '-q', '--no-ff', '--no-edit', own);
    const out = f.check(['--event', f.event(30, main, own)]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, new RegExp(`${own.slice(0, 7)}: No-docs: own needs none`));
  });

  test("in Actions, the event's base is older than the merge's: what lies between isn't its", () => {
    const f = fixture();
    const { work } = f;
    work.git('checkout', '-q', '-b', 'late');
    const head = work.commit('late', { [CONTRACT]: 'export const a = 11;\n' });
    work.pull(32, head);
    work.git('checkout', '-q', 'main');
    const stale = work.commit('main moves on (#31)', { 'notes.txt': 'y\n' });
    work.commit('another pull request, with its page (#33)', { [PAGE]: '# Acme\n' });
    work.git('push', '-q', 'origin', 'main');
    work.git('checkout', '-q', '--detach', 'main');
    work.git('merge', '-q', '--no-ff', '--no-edit', head);
    const event = f.event(32, stale, head);

    const out = f.check(['--event', event]);
    assert.equal(out.status, 1, out.stdout);
    assert.match(out.stderr, /commands\/acme\.ts/);
    // Against the event's base commit, the other pull request's page let it through.
    assert.equal(f.check([stale, '--event', event]).status, 0);
  });

  test('one branch open as two pull requests: the other number is still its own head', () => {
    const f = fixture();
    const { work } = f;
    work.git('checkout', '-q', '-b', 'twice');
    const head = work.commit('twice\n\nNo-docs: twice needs none', {
      [CONTRACT]: 'export const a = 6;\n',
    });
    work.pull(40, head);
    work.pull(41, head);
    const out = f.check(['--event', f.event(40, work.git('rev-parse', 'main'), head)]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /No-docs: twice needs none/);
  });

  /**
   * A parent pull request (#50) whose older head this branch (#51) merged;
   * elsewhere the parent moves on and is squashed into main, and this
   * branch merges main. Its latest head was never fetched here.
   */
  const olderHead = (f) => {
    const { work } = f;
    work.git('checkout', '-q', '-b', 'parent');
    const older = work.commit('the parent\n\nNo-docs: the parent needs none', {
      [CONTRACT]: 'export const a = 7;\n',
    });
    work.git('push', '-q', 'origin', 'parent');
    work.pull(50, older);
    work.git('checkout', '-q', '-b', 'late');
    work.commit('late', { [CONTRACT_2]: 'export const b = 3;\n' });
    const other = f.elsewhere();
    other.git('fetch', '-q', 'origin', 'parent');
    other.git('checkout', '-q', '-b', 'parent', 'FETCH_HEAD');
    const latest = other.commit('the parent, reviewed', { 'parent-notes.txt': 'y\n' });
    other.pull(50, latest);
    other.git('checkout', '-q', 'main');
    other.git('merge', '-q', '--squash', 'parent');
    other.commit('The parent (#50)');
    other.git('push', '-q', 'origin', 'main');
    work.git('fetch', '-q', 'origin', 'main');
    work.git('merge', '-q', '--no-edit', 'origin/main');
    const head = work.git('rev-parse', 'HEAD');
    work.pull(51, head);
    assert.equal(
      spawnSync('git', ['cat-file', '-e', `${latest}^{commit}`], { cwd: work.dir, env: ENV })
        .status,
      128,
      "the parent's latest head isn't in the work clone",
    );
    return { older, head, base: work.git('rev-parse', 'origin/main') };
  };

  test('an older head of a squashed pull request, merged in before it moved on, is still its', () => {
    const f = fixture();
    const { older, head, base } = olderHead(f);
    const out = f.check(['--event', f.event(51, base, head)]);
    assert.equal(out.status, 1, out.stdout);
    assert.match(out.stdout, /fetching 1 squashed pull request head/);
    assert.match(
      out.stderr,
      new RegExp(
        `skipped in ${older.slice(0, 7)} \\(carried by #50, squashed into the base\\): No-docs: the parent needs none`,
      ),
    );
  });

  test('fetching a squashed head fails: in Actions the check fails; elsewhere it warns and its commits count', () => {
    const f = fixture();
    const { older, head, base } = olderHead(f);
    // A fetch can't write FETCH_HEAD; listing the heads still works.
    const fetchHead = join(f.work.dir, '.git', 'FETCH_HEAD');
    rmSync(fetchHead, { force: true });
    mkdirSync(fetchHead);

    const strict = f.check(['--event', f.event(51, base, head)]);
    assert.equal(strict.status, 1, strict.stdout);
    assert.match(strict.stderr, /can't fetch the squashed pull requests' heads/);

    f.gh({ number: 51, state: 'OPEN', baseRefName: 'main', baseRefOid: base, headRefOid: head });
    const local = f.check();
    assert.equal(local.status, 0, local.stderr);
    assert.match(local.stdout, /warning: can't fetch the squashed pull requests' heads/);
    assert.match(local.stdout, new RegExp(`${older.slice(0, 7)}: No-docs: the parent needs none`));
  });

  test('its own commits, carried by one squashed into the base: its lines are skipped until it merges the base', () => {
    const f = fixture();
    const { work } = f;
    work.git('checkout', '-q', '-b', 'mine');
    const line = work.commit('mine\n\nNo-docs: mine needs none', {
      [CONTRACT]: 'export const a = 11;\n',
    });
    work.pull(100, line);
    work.git('checkout', '-q', '-b', 'carrier');
    work.pull(101, work.commit('the carrier', { 'carrier.txt': 'c\n' }));
    work.git('checkout', '-q', 'main');
    work.git('merge', '-q', '--squash', 'carrier');
    const main = work.commit('The carrier (#101)');
    work.git('push', '-q', 'origin', 'main');
    work.git('checkout', '-q', 'mine');

    const failed = f.check(['--event', f.event(100, main, line)]);
    assert.equal(failed.status, 1, failed.stdout);
    assert.match(
      failed.stderr,
      new RegExp(
        `skipped in ${line.slice(0, 7)} \\(carried by #101, squashed into the base\\): No-docs: mine needs none`,
      ),
    );

    // Merging the base takes what landed with the carrier out of its diff.
    work.git('merge', '-q', '--no-edit', 'main');
    const head = work.git('rev-parse', 'HEAD');
    work.pull(100, head);
    const merged = f.check(['--event', f.event(100, main, head)]);
    assert.equal(merged.status, 0, merged.stderr);
    assert.match(merged.stdout, /no public contract changed/);
  });

  test('outside Actions, gh pr view gives the pull request and its base, as Actions would', () => {
    const f = fixture();
    const { work } = f;
    work.git('checkout', '-q', '-b', 'base-pr');
    const basePr = work.commit('the base pull request, with its page', {
      [CONTRACT]: 'export const a = 8;\n',
      [PAGE]: '# Acme\n',
    });
    work.git('push', '-q', 'origin', 'base-pr');
    work.pull(60, basePr);
    work.git('checkout', '-q', '-b', 'stacked');
    const head = work.commit('stacked', { [CONTRACT_2]: 'export const b = 4;\n' });
    work.pull(61, head);
    // The base moves on where this clone hasn't fetched it.
    const other = f.elsewhere();
    other.git('fetch', '-q', 'origin', 'base-pr');
    other.git('checkout', '-q', '-b', 'base-pr', 'FETCH_HEAD');
    const moved = other.commit('the base, reviewed', { 'base-notes.txt': 'z\n' });
    other.git('push', '-q', 'origin', 'base-pr');
    other.pull(60, moved);
    f.gh({
      number: 61,
      state: 'OPEN',
      baseRefName: 'base-pr',
      baseRefOid: moved,
      headRefOid: head,
    });

    const out = f.check(['--pr', '61']);
    assert.equal(out.status, 1, out.stdout);
    assert.match(out.stderr, /acme-two\.ts/);
    assert.doesNotMatch(out.stderr, /commands\/acme\.ts/);
    assert.match(
      execFileSync('cat', [join(f.root, 'gh-args')], { encoding: 'utf8' }),
      /^pr view 61 --json /,
    );
  });

  test('outside Actions with no pull request found: as before, every commit counts, and it says so', () => {
    const f = fixture();
    const { work } = f;
    work.git('checkout', '-q', '-b', 'mine');
    const line = work.commit('mine\n\nNo-docs: mine needs none', {
      [CONTRACT]: 'export const a = 9;\n',
    });
    // Its own pull request is open; gh can't say which it is.
    work.pull(70, line);
    f.gh(undefined);
    const out = f.check();
    assert.equal(out.status, 0, out.stderr);
    assert.match(
      out.stdout,
      /warning: no pull request found \(no pull requests found for branch\)/,
    );
    assert.match(out.stdout, new RegExp(`${line.slice(0, 7)}: No-docs: mine needs none`));
  });

  test("outside Actions, gh's closed or merged pull request for the branch isn't its own", () => {
    const f = fixture();
    const { work } = f;
    work.git('checkout', '-q', '-b', 'reused');
    const line = work.commit('reused\n\nNo-docs: reused needs none', {
      [CONTRACT]: 'export const a = 12;\n',
    });
    work.pull(72, line);
    const main = work.git('rev-parse', 'main');
    // An older pull request from a branch of the same name, merged.
    f.gh({ number: 71, state: 'MERGED', baseRefName: 'main', baseRefOid: main, headRefOid: B });

    const out = f.check();
    assert.equal(out.status, 0, out.stderr);
    assert.match(
      out.stdout,
      /warning: no open pull request found \(#71 is merged\); comparing with origin\/main/,
    );
    assert.match(out.stdout, new RegExp(`${line.slice(0, 7)}: No-docs: reused needs none`));
    // Asked for by number, it is checked as that one: #72's head isn't its own.
    const asked = f.check(['--pr', '71']);
    assert.equal(asked.status, 1, asked.stdout);
    assert.match(asked.stderr, /\(carried by #72\): No-docs: reused needs none/);
  });

  test("outside Actions, a pull request whose base can't be had: it says which, and every commit counts", () => {
    const f = fixture();
    const { work } = f;
    work.git('checkout', '-q', '-b', 'based');
    const line = work.commit('based\n\nNo-docs: based needs none', {
      [CONTRACT]: 'export const a = 13;\n',
    });
    work.pull(73, line);

    f.gh({ number: 73, state: 'OPEN', baseRefName: 'main', baseRefOid: C, headRefOid: line });
    const gone = f.check();
    assert.equal(gone.status, 0, gone.stderr);
    assert.match(
      gone.stdout,
      /warning: can't use pull request #73 \(its base commit ccccccc isn't here after a fetch\); comparing with origin\/main/,
    );
    assert.match(gone.stdout, new RegExp(`${line.slice(0, 7)}: No-docs: based needs none`));

    f.gh({ number: 73, state: 'OPEN', baseRefName: 'deleted', baseRefOid: C, headRefOid: line });
    const unfetched = f.check();
    assert.equal(unfetched.status, 0, unfetched.stderr);
    assert.match(unfetched.stdout, /warning: can't use pull request #73 \(fetching its base: /);
  });

  test('listing the heads fails: in Actions the check fails; elsewhere it warns and goes on', () => {
    const f = fixture();
    const { work } = f;
    work.git('checkout', '-q', '-b', 'offline');
    const head = work.commit('offline\n\nNo-docs: offline needs none', {
      [CONTRACT]: 'export const a = 10;\n',
    });
    work.pull(80, head);
    const main = work.git('rev-parse', 'main');
    work.git('remote', 'set-url', 'origin', join(f.root, 'gone.git'));

    const strict = f.check(['--event', f.event(80, main, head)]);
    assert.equal(strict.status, 1, strict.stdout);
    assert.match(strict.stderr, /can't list the other pull requests' heads/);

    f.gh({ number: 80, state: 'OPEN', baseRefName: 'main', baseRefOid: main, headRefOid: head });
    const local = f.check();
    assert.equal(local.status, 0, local.stderr);
    assert.match(local.stdout, /warning: can't list the other pull requests' heads/);
  });

  test('a page, a reference entry, a skill, a README or the contributor docs are its docs', () => {
    const f = fixture();
    const { work } = f;
    const docs = [
      'site/src/content/docs/guides/acme.md',
      'site/scripts/reference/entries/errors.mjs',
      'packages/sdk/skills/acme/SKILL.md',
      'packages/cli/README.md',
      'docs/ACME.md',
    ];
    for (const [n, path] of docs.entries()) {
      work.git('checkout', '-q', '-b', `documented-${n}`, 'main');
      const head = work.commit(`documented in ${path}`, {
        [CONTRACT]: `export const a = ${100 + n};\n`,
        [path]: 'words\n',
      });
      work.pull(100 + n, head);
      const out = f.check(['--event', f.event(100 + n, work.git('rev-parse', 'main'), head)]);
      assert.equal(out.status, 0, `${path}: ${out.stderr}`);
      assert.match(out.stdout, /1 contract file\(s\) changed, with docs/, path);
    }
  });

  test("the reference's builders are code, not docs", () => {
    const f = fixture();
    const { work } = f;
    work.git('checkout', '-q', '-b', 'builder');
    const head = work.commit('a builder', {
      [CONTRACT]: 'export const a = 110;\n',
      'site/scripts/reference/errors.mjs': 'export {};\n',
    });
    work.pull(110, head);
    const out = f.check(['--event', f.event(110, work.git('rev-parse', 'main'), head)]);
    assert.equal(out.status, 1, out.stdout);
    assert.match(out.stderr, /a reference entry in\nsite\/scripts\/reference\/entries\//);
  });

  test('no contract changed, through a symlink: it runs and says so', () => {
    const f = fixture();
    const { work } = f;
    work.git('checkout', '-q', '-b', 'notes');
    const head = work.commit('notes', { 'notes.txt': 'n\n' });
    const linked = join(f.root, 'check-docs-ship.mjs');
    symlinkSync(SCRIPT, linked);
    const out = spawnSync(
      process.execPath,
      [linked, '--event', f.event(90, work.git('rev-parse', 'main'), head)],
      { cwd: work.dir, encoding: 'utf8', env: ENV },
    );
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /no public contract changed/);
  });
});
