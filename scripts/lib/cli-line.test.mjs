// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
// reads-source: packages/cli/src/package-manager.ts packages/cli/src/init/dependency-specs.ts

/**
 * Tests for scripts/lib/cli-line.mjs: its two install forms against the
 * CLI's own functions, built (packages/cli/dist, which the root `ci` builds
 * before `test:scripts`), the forms it finds and moves, and the files it
 * reads. Run: `pnpm run build`, then `pnpm run test:scripts`.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  followsCliLine,
  lineOf,
  moveToLine,
  npmCliSpec,
  offLine,
  uvCliRequirement,
  withoutCliLine,
} from './cli-line.mjs';

/** A file's name, built so check-refs doesn't read it as a document reference. */
const md = (name) => `${name}.md`;

/** A module of the built CLI; without a build, the test fails and says so. */
async function builtCli(file) {
  const path = fileURLToPath(new URL(`../../packages/cli/dist/${file}`, import.meta.url));
  if (!existsSync(path)) {
    assert.fail(`${path} is missing: run \`pnpm run build\` first, as the root \`ci\` does`);
  }
  return import(pathToFileURL(path).href);
}

const VERSIONS = [
  '0.4.0',
  '0.6.0',
  '0.6.0-rc.1',
  '0.6.0-rc.10',
  '0.6.0-alpha.1',
  '0.6.0-beta.2',
  '1.0.0',
  '1.2.0-rc.0',
];

describe("the CLI's own forms", () => {
  test("npmCliSpec is the built CLI's publishedCliSpec", async () => {
    const { publishedCliSpec } = await builtCli('package-manager.js');
    for (const version of VERSIONS) {
      assert.equal(npmCliSpec(version), publishedCliSpec(version), version);
    }
  });

  test("uvCliRequirement is the built CLI's kindgiCliRequirement", async () => {
    const { kindgiCliRequirement } = await builtCli('init/dependency-specs.js');
    for (const version of VERSIONS) {
      assert.equal(uvCliRequirement(version), kindgiCliRequirement(version), version);
    }
  });

  test('a release takes its line, and a pre-release its exact build', () => {
    assert.equal(npmCliSpec('0.4.0'), '@kindgi/cli@0.4');
    assert.equal(npmCliSpec('0.6.0-rc.1'), '@kindgi/cli@0.6.0-rc.1');
    assert.equal(npmCliSpec('1.2.3'), '@kindgi/cli@1.2');
    assert.equal(uvCliRequirement('0.4.0'), 'kindgi-cli>=0.4,<0.5');
    assert.equal(uvCliRequirement('0.6.0-rc.10'), 'kindgi-cli>=0.6.0rc10,<0.7');
    assert.equal(uvCliRequirement('0.6.0-alpha.1'), 'kindgi-cli>=0.6.0a1,<0.7');
    assert.equal(uvCliRequirement('0.6.0-beta.2'), 'kindgi-cli>=0.6.0b2,<0.7');
    assert.equal(uvCliRequirement('1.2.0'), 'kindgi-cli>=1.2,<2');
    assert.equal(lineOf('0.6.0-rc.1'), '0.6');
    assert.equal(lineOf('0.10.2'), '0.10');
  });
});

const AT_02 = [
  '```sh',
  'npx --yes @kindgi/cli@0.2 init my-pack',
  'uvx --from "kindgi-cli>=0.2,<0.3" kindgi doctor',
  '```',
  '',
  "- **A pack** with `kindgi dev` running, from Kindgi 0.2's CLI.",
  "- **A backend** with Kindgi 0.2's client, and the Kindgi 0.2 CLI.",
  '',
].join('\n');
const AT_04 = [
  '```sh',
  'npx --yes @kindgi/cli@0.4 init my-pack',
  'uvx --from "kindgi-cli>=0.4,<0.5" kindgi doctor',
  '```',
  '',
  "- **A pack** with `kindgi dev` running, from Kindgi 0.4's CLI.",
  "- **A backend** with Kindgi 0.5's client, and the Kindgi 0.4 CLI.",
  '',
].join('\n');
const ON_04 = { cli: '0.4.0', sdk: '0.5.0' };

describe('offLine', () => {
  test('names each form off the line, by line, with what it should say', () => {
    assert.deepEqual(offLine(AT_02, ON_04), [
      { line: 2, found: '@kindgi/cli@0.2', want: '@kindgi/cli@0.4' },
      { line: 3, found: 'kindgi-cli>=0.2,<0.3', want: 'kindgi-cli>=0.4,<0.5' },
      { line: 6, found: "Kindgi 0.2's CLI", want: "Kindgi 0.4's CLI" },
      { line: 7, found: "Kindgi 0.2's client", want: "Kindgi 0.5's client" },
      { line: 7, found: 'Kindgi 0.2 CLI', want: 'Kindgi 0.4 CLI' },
    ]);
    assert.deepEqual(offLine(AT_04, ON_04), []);
  });

  test('at a pre-release, the install forms take the build and the prose its line', () => {
    const rc = { cli: '0.6.0-rc.1', sdk: '0.6.0-rc.1' };
    assert.deepEqual(
      offLine(AT_04, rc).map(({ want }) => want),
      [
        '@kindgi/cli@0.6.0-rc.1',
        'kindgi-cli>=0.6.0rc1,<0.7',
        "Kindgi 0.6's CLI",
        "Kindgi 0.6's client",
        'Kindgi 0.6 CLI',
      ],
    );
  });

  test('names a form with a version the rule never writes', () => {
    const odd = 'npx --yes @kindgi/cli@0 dev and uv add --dev "kindgi-cli>=0.4"';
    assert.deepEqual(
      offLine(odd, ON_04).map(({ found }) => found),
      ['@kindgi/cli@0', 'kindgi-cli>=0.4'],
    );
  });

  test('finds a phrase wrapped over two lines, and names it on one', () => {
    const wrapped = "From Kindgi\n0.2's CLI, and Kindgi 0.2's\nclient.";
    assert.deepEqual(offLine(wrapped, ON_04), [
      { line: 1, found: "Kindgi 0.2's CLI", want: "Kindgi 0.4's CLI" },
      { line: 2, found: "Kindgi 0.2's client", want: "Kindgi 0.5's client" },
    ]);
  });
});

describe('moveToLine', () => {
  test('moves every form, and a second move changes nothing', () => {
    assert.deepEqual(moveToLine(AT_02, ON_04), { text: AT_04, moved: 5 });
    assert.deepEqual(moveToLine(AT_04, ON_04), { text: AT_04, moved: 0 });
  });

  test("keeps a sentence's full stop, and moves a two-digit minor", () => {
    assert.deepEqual(moveToLine('Run @kindgi/cli@0.2.', { cli: '0.10.0', sdk: '0.10.0' }), {
      text: 'Run @kindgi/cli@0.10.',
      moved: 1,
    });
    assert.deepEqual(
      moveToLine('uvx --from "kindgi-cli>=0.9,<0.10" kindgi', { cli: '0.10.0', sdk: '0.10.0' }),
      { text: 'uvx --from "kindgi-cli>=0.10,<0.11" kindgi', moved: 1 },
    );
  });

  test('moves prose with a typographic apostrophe too, keeping it', () => {
    assert.deepEqual(moveToLine('From Kindgi 0.2’s CLI.', ON_04), {
      text: 'From Kindgi 0.4’s CLI.',
      moved: 1,
    });
  });

  test('moves a wrapped phrase, keeping its break and indent', () => {
    const wrapped = "- From Kindgi\n  0.2's CLI, and the Kindgi 0.2\n  CLI.";
    const moved = "- From Kindgi\n  0.4's CLI, and the Kindgi 0.4\n  CLI.";
    assert.deepEqual(moveToLine(wrapped, ON_04), { text: moved, moved: 2 });
    assert.deepEqual(moveToLine(moved, ON_04), { text: moved, moved: 0 });
  });

  test('leaves a placeholder, printed output and a bare package alone', () => {
    const text = [
      'npx --yes @kindgi/cli@<version> doctor',
      ' + kindgi-cli==0.2.0',
      'npx --yes @kindgi/cli doctor',
      'uvx --from kindgi-cli kindgi doctor',
      'Kindgi 0.2 runtime, @kindgi/sdk@0.3.0, kindgi>=0.2,<0.3',
    ].join('\n');
    assert.deepEqual(moveToLine(text, ON_04), { text, moved: 0 });
  });
});

describe('withoutCliLine', () => {
  test("takes every form's version out, so a move is no change", () => {
    const at = (npm, uv, line) =>
      `@kindgi/cli@${npm} "kindgi-cli>=${uv}" Kindgi ${line}'s CLI, Kindgi ${line}'s client`;
    const out = withoutCliLine(at('0.4', '0.4,<0.5', '0.4'));
    assert.equal(
      out,
      '@kindgi/cli@X.Y "kindgi-cli>=X.Y,<X.Y" Kindgi X.Y\'s CLI, Kindgi X.Y\'s client',
    );
    assert.equal(withoutCliLine(at('0.6.0-rc.1', '0.6.0rc1,<0.7', '0.6')), out);
    assert.equal(withoutCliLine(at('1.0', '1.0,<2', '1.0')), out);
  });
});

describe('followsCliLine', () => {
  test('reads the docs pages, the skills and the READMEs', () => {
    for (const file of [
      md('site/src/content/docs/start/install'),
      'site/src/content/docs/guides/tools/mcp-servers.mdx',
      md('packages/sdk/skills/kindgi-java-getting-started/SKILL'),
      md('packages/sdk/skills/kindgi-using/run-a-pack'),
      md('packages/cli/README'),
      md('packages/adapters/model-acme/README'),
      md('sdks/python/README'),
      md('deploy/gcp-cloud-run/README'),
      md('README'),
    ]) {
      assert.equal(followsCliLine(file), true, file);
    }
  });

  test('leaves the release notes, changelogs, tests, scripts and other markdown alone', () => {
    for (const file of [
      md('site/src/content/docs/releases/0.4.0'),
      'site/src/content/docs/start/diagram.svg',
      md('packages/cli/CHANGELOG'),
      'packages/cli/tests/package-manager.test.ts',
      'packages/cli/src/init/dependency-specs.ts',
      'deploy/gcp-cloud-run/upgrade.sh',
      md('deploy/gcp-cloud-run/docs/README'),
      md('CONTRIBUTING'),
      'site/scripts/check-cli-launch.mjs',
    ]) {
      assert.equal(followsCliLine(file), false, file);
    }
  });
});
