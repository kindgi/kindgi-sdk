// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
// reads-source: none

/**
 * Tests for `scripts/sync-docs-line.mjs`: which files follow the docs line
 * (scripts/lib/docs-line.mjs), moving the links in a text, and the command
 * itself in a scratch repository, with scripts/check-refs.mjs reading the
 * result. Run: `pnpm run test:scripts`.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { docsLineOf, followsDocsLine } from './lib/docs-line.mjs';
import { scratchRepoEnv } from './lib/git-env.mjs';
import { moveLinks } from './sync-docs-line.mjs';

const SCRIPT = fileURLToPath(new URL('./sync-docs-line.mjs', import.meta.url));
const CHECK_REFS = fileURLToPath(new URL('./check-refs.mjs', import.meta.url));
/** git's repository variables dropped, so a shell pointing at another repository leaves it alone. */
const scratchEnv = scratchRepoEnv();
const scratch = mkdtempSync(join(tmpdir(), 'kindgi-sync-docs-line-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const V01 = 'https://docs.kindgi.com/v0.1/';
const V02 = 'https://docs.kindgi.com/v0.2/';
/** A path ending in `.md`, spelled so check-refs doesn't take a scratch repository's for this one's. */
const md = (path) => `${path}.md`;
const ACME_SKILL = md('packages/sdk/skills/acme-skill/SKILL');
const ACME_CONTRIBUTING = md('.claude/skills/acme-contributing/SKILL');
const DRAFT_SKILL = md('packages/sdk/skills/draft/SKILL');

describe('docsLineOf', () => {
  test("is the version's major and minor, its patch and prerelease aside", () => {
    assert.equal(docsLineOf('0.2.0-rc.0'), V02);
    assert.equal(docsLineOf('0.2.7'), V02);
    assert.equal(docsLineOf('1.10.0'), 'https://docs.kindgi.com/v1.10/');
  });
});

describe('followsDocsLine', () => {
  test("takes every SKILL.md, the files beside a shipped skill's, and what a package or SDK ships from its src/", () => {
    for (const file of [
      ACME_SKILL,
      ACME_CONTRIBUTING,
      'SKILL.md',
      md('packages/sdk/skills/acme-skill/reference'),
      'packages/cli/src/commands/init.ts',
      md('packages/cli/src/templates/AGENTS'),
      'sdks/python/src/kindgi/client.py',
      'sdks/java/kindgi-client/src/main/java/com/kindgi/client/Docs.java',
    ]) {
      assert.ok(followsDocsLine(file), file);
    }
  });

  test('leaves out tests, docs and anything else', () => {
    for (const file of [
      'packages/cli/src/test/init.ts',
      'packages/cli/src/commands/init.test.ts',
      'sdks/java/kindgi-client/src/test/java/com/kindgi/client/DocsLinksTest.java',
      'packages/sdk/README.md',
      md('packages/sdk/skills/acme-skill/nested/reference'),
      md('.claude/skills/acme-skill/reference'),
      'packages/sdk/skills/acme-skill/diagram.png',
      md('docs/guides/acme'),
      'scripts/check-refs.mjs',
      'src/index.ts',
    ]) {
      assert.ok(!followsDocsLine(file), file);
    }
  });
});

describe('moveLinks', () => {
  test('moves each link on another line, and keeps the rest of the text as it is', () => {
    const text = [
      `See ${V01}guides/connections/use-a-connection#scopes.`,
      `Or [the CLI](${V01}reference/cli) and <${'https://docs.kindgi.com/v1.4/'}deploy>.`,
      `Already on the line: ${V02}guides/improve.`,
      '',
    ].join('\r\n');
    assert.deepEqual(moveLinks(text, V02), {
      text: [
        `See ${V02}guides/connections/use-a-connection#scopes.`,
        `Or [the CLI](${V02}reference/cli) and <${V02}deploy>.`,
        `Already on the line: ${V02}guides/improve.`,
        '',
      ].join('\r\n'),
      moved: 3,
    });
  });

  test("leaves a link on no line, on a patch version's, or on another host", () => {
    const text = [
      'https://docs.kindgi.com/guides/improve',
      'https://docs.kindgi.com/v0.1.10/guides/improve',
      'https://docs.kindgi.com/next/guides/improve',
      'https://docs.kindgi.com/v0.1',
      'http://docs.kindgi.com/v0.1/guides/improve',
      'https://docs.kindgi.com.acme.example/v0.1/guides/improve',
      'https://acme.example/docs.kindgi.com/v0.1x/guides',
    ].join('\n');
    assert.deepEqual(moveLinks(text, V02), { text, moved: 0 });
  });

  test('moves a two-digit minor, and to one', () => {
    assert.deepEqual(moveLinks('https://docs.kindgi.com/v0.10/a', V02), {
      text: `${V02}a`,
      moved: 1,
    });
    assert.deepEqual(moveLinks(`${V01}a`, 'https://docs.kindgi.com/v0.10/'), {
      text: 'https://docs.kindgi.com/v0.10/a',
      moved: 1,
    });
  });
});

// ---- the command ------------------------------------------------------------

const SKILL = (base) =>
  [
    '---',
    'name: acme-skill',
    'description: Builds an acme agent.',
    '---',
    '',
    `Start with [the guide](${base}guides/get-started).`,
    `Connections: ${base}guides/connections/use-a-connection#scopes.`,
    '',
  ].join('\n');
const SHIPPED = (base) => `export const HINT = 'Read ${base}reference/cli';\n`;
const NOT_FOLLOWING = `Changelog and tests keep theirs: ${V01}guides/get-started\n`;

let n = 0;
/** A scratch repository at `sdk`'s version, every file tracked unless `untracked` names it. */
function repo({ sdk = '0.2.0-rc.0', files = {}, untracked = {} } = {}) {
  n += 1;
  const root = join(scratch, `repo-${n}`);
  const write = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
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

const run = (root, script = SCRIPT, args = []) =>
  spawnSync(process.execPath, [script, ...args], { cwd: root, env: scratchEnv, encoding: 'utf8' });
const read = (root, file) => readFileSync(join(root, file), 'utf8');

const FILES = {
  [ACME_SKILL]: SKILL(V01),
  [ACME_CONTRIBUTING]: SKILL(V01),
  'packages/cli/src/hint.ts': SHIPPED(V01),
  'packages/cli/src/hint.test.ts': NOT_FOLLOWING,
  'packages/cli/CHANGELOG.md': NOT_FOLLOWING,
};

describe('sync-docs-line', () => {
  test("moves the links in exactly rule 4's files, and check-refs then passes", () => {
    const root = repo({
      files: FILES,
      untracked: { [DRAFT_SKILL]: SKILL(V01) },
    });
    const before = run(root, CHECK_REFS);
    assert.equal(before.status, 1, before.stdout);
    assert.equal((before.stderr.match(/release line's docs/g) ?? []).length, 5, before.stderr);

    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(read(root, ACME_SKILL), SKILL(V02));
    assert.equal(read(root, ACME_CONTRIBUTING), SKILL(V02));
    assert.equal(read(root, 'packages/cli/src/hint.ts'), SHIPPED(V02));
    assert.equal(read(root, 'packages/cli/src/hint.test.ts'), NOT_FOLLOWING);
    assert.equal(read(root, 'packages/cli/CHANGELOG.md'), NOT_FOLLOWING);
    assert.equal(read(root, DRAFT_SKILL), SKILL(V01), 'untracked');
    assert.match(
      result.stdout,
      /packages\/sdk\/skills\/acme-skill\/SKILL\.md: 2 link\(s\) → https:\/\/docs\.kindgi\.com\/v0\.2\//,
    );
    assert.match(
      result.stdout,
      /5 link\(s\) in 3 of 3 file\(s\) moved to .*\(@kindgi\/sdk 0\.2\.0-rc\.0\)/,
    );

    const checked = run(root, CHECK_REFS);
    assert.equal(checked.status, 0, checked.stderr);
  });

  test('a second run changes nothing', () => {
    const root = repo({ files: FILES });
    assert.equal(run(root).status, 0);
    const again = run(root);
    assert.equal(again.status, 0, again.stderr);
    assert.match(
      again.stdout,
      /3 file\(s\) read; every link on a line is on https:\/\/docs\.kindgi\.com\/v0\.2\//,
    );
    assert.equal(read(root, ACME_SKILL), SKILL(V02));
  });

  test("leaves a link on no line, or a patch version's, for check-refs to name", () => {
    const patch =
      'Pinned: https://docs.kindgi.com/v0.1.10/guides/get-started\nNo line: https://docs.kindgi.com/guides/improve\n';
    const root = repo({ files: { [ACME_SKILL]: patch } });
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(read(root, ACME_SKILL), patch);
    const checked = run(root, CHECK_REFS);
    assert.equal(checked.status, 1);
    assert.match(
      checked.stderr,
      /links https:\/\/docs\.kindgi\.com\/v0\.1\.10\/guides\/get-started; a skill links/,
    );
    assert.match(
      checked.stderr,
      /links https:\/\/docs\.kindgi\.com\/guides\/improve; a skill links/,
    );
  });

  test("skips a tracked file that's gone from the checkout", () => {
    const root = repo({ files: FILES });
    unlinkSync(join(root, ACME_CONTRIBUTING));
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /3 link\(s\) in 2 of 2 file\(s\)/);
  });

  test('refuses an argument, and a version with no line, writing nothing', () => {
    const root = repo({ files: FILES });
    const extra = run(root, SCRIPT, ['--release']);
    assert.equal(extra.status, 1);
    assert.match(extra.stderr, /sync-docs-line: unknown argument --release; usage:/);

    const bad = repo({ sdk: 'next', files: FILES });
    const refused = run(bad);
    assert.equal(refused.status, 1);
    assert.match(
      refused.stderr,
      /packages\/sdk\/package\.json has no version a docs line can come from/,
    );
    assert.equal(read(bad, ACME_SKILL), SKILL(V01));
  });

  test("refuses a file with links to move that isn't UTF-8, and writes no file", () => {
    const root = repo({
      files: {
        // git lists it before the bad file, so it's read, and would be moved, first.
        [ACME_CONTRIBUTING]: SKILL(V01),
        'packages/cli/src/zz.bin': Buffer.concat([Buffer.from(V01), Buffer.from([0xff, 0xfe])]),
      },
    });
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /packages\/cli\/src\/zz\.bin links docs on another line but isn't UTF-8 text/,
    );
    assert.equal(read(root, ACME_CONTRIBUTING), SKILL(V01));
  });
});
