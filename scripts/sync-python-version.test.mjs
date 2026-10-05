// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Tests for `scripts/sync-python-version.mjs`: the PEP 440 spelling, the
 * readers, the fixed-group check, and the command itself in a scratch
 * workspace (`--check`; writing, with uv). Run: `pnpm run test:scripts`.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SyncError,
  fixedGroupVersion,
  lockedVersion,
  projectString,
  toPep440,
} from './sync-python-version.mjs';

const SCRIPT = fileURLToPath(new URL('./sync-python-version.mjs', import.meta.url));
const REPO = dirname(dirname(SCRIPT));
const HAS_UV = spawnSync('uv', ['--version']).status === 0;
const scratch = mkdtempSync(join(tmpdir(), 'kindgi-sync-python-version-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

describe('toPep440', () => {
  test('a release keeps its spelling; alpha, beta and rc become a, b and rc', () => {
    assert.equal(toPep440('0.1.2'), '0.1.2');
    assert.equal(toPep440('10.20.30'), '10.20.30');
    assert.equal(toPep440('1.0.0-alpha.0'), '1.0.0a0');
    assert.equal(toPep440('1.0.0-beta.3'), '1.0.0b3');
    assert.equal(toPep440('2.1.0-rc.12'), '2.1.0rc12');
  });

  test('anything else is refused', () => {
    for (const version of [
      '1.0.0-preview.3',
      '1.0.0-next.0',
      '1.0.0-alpha',
      '1.0.0-rc.1.2',
      '1.0.0-RC.1',
      '1.0.0+build.1',
      '1.0.0-rc.01',
      '01.0.0',
      '1.0',
      'v1.0.0',
      '',
    ]) {
      assert.throws(() => toPep440(version), SyncError, version);
    }
    assert.throws(() => toPep440('1.0.0-preview.3'), /has no PEP 440 spelling/);
  });
});

describe('projectString', () => {
  const pyproject = [
    '# version = "0.0.1" in a comment',
    'version = "0.0.2"',
    '',
    '[tool.acme]',
    'version = "0.0.3"',
    '',
    '[ project ]  # the table',
    'name = "acme-x"',
    'description = """',
    'version = "0.0.4"',
    '"""',
    "notes = '''one line''' # a closed multi-line literal",
    'version = "1.2.0"  # the one',
    '',
    '[project.urls]',
    'version = "0.0.5"',
    '',
    '[[tool.acme.entry]]',
    'version = "0.0.6"',
    '',
  ].join('\n');

  test("reads [project]'s key, and nothing outside it", () => {
    assert.equal(projectString(pyproject, 'version', 'f'), '1.2.0');
    assert.equal(projectString(pyproject, 'name', 'f'), 'acme-x');
    assert.equal(projectString(pyproject.replaceAll('\n', '\r\n'), 'version', 'f'), '1.2.0');
    assert.equal(projectString("[project]\nversion = '3.0.0rc1'\n", 'version', 'f'), '3.0.0rc1');
  });

  test("reads this repository's Python SDK", () => {
    const text = readFileSync(join(REPO, 'sdks/python/pyproject.toml'), 'utf8');
    assert.equal(projectString(text, 'name', 'f'), 'kindgi');
    assert.match(projectString(text, 'version', 'f'), /^\d+\.\d+\.\d+/);
  });

  test('refuses what it would have to guess', () => {
    assert.throws(() => projectString('[tool.x]\nversion = "1.0.0"\n', 'version', 'f'), {
      message: 'f has no [project] table',
    });
    assert.throws(
      () => projectString('[project]\nname = "x"\ndynamic = ["version"]\n', 'version', 'f'),
      /has no one-line `version = "…"`/,
    );
    assert.throws(
      () => projectString('[project]\nversion = """1.0.0"""\n', 'version', 'f'),
      /has no one-line/,
    );
    assert.throws(
      () => projectString('[project]\nversion = "1.0.0"\nversion = "1.0.1"\n', 'version', 'f'),
      /has 2 `version` lines/,
    );
  });
});

describe('lockedVersion', () => {
  const lock = [
    'version = 1',
    'revision = 3',
    '',
    '[[package]]',
    'name = "acme-x"',
    'version = "1.2.0"',
    'source = { editable = "." }',
    'dependencies = [',
    '    { name = "httpx" },',
    ']',
    '',
    '[package.dev-dependencies]',
    'version = "9.9.9"',
    '',
    '[[package]]',
    'name = "acme-x"',
    'version = "0.0.1"',
    'source = { registry = "https://pypi.org/simple" }',
    '',
  ].join('\n');

  test("reads the project's own entry, by its normalized name", () => {
    assert.equal(lockedVersion(lock, 'acme-x', 'f'), '1.2.0');
    assert.equal(lockedVersion(lock, 'Acme_X', 'f'), '1.2.0');
    assert.equal(
      lockedVersion(lock.replace('editable = "."', 'virtual = "."'), 'acme-x', 'f'),
      '1.2.0',
    );
  });

  test("reads this repository's Python SDK, at its pyproject version", () => {
    const pyproject = readFileSync(join(REPO, 'sdks/python/pyproject.toml'), 'utf8');
    const text = readFileSync(join(REPO, 'sdks/python/uv.lock'), 'utf8');
    assert.equal(lockedVersion(text, 'kindgi', 'f'), projectString(pyproject, 'version', 'f'));
  });

  test('refuses a lock without the project', () => {
    assert.throws(() => lockedVersion(lock, 'acme-y', 'f'), {
      message: 'f has no version for acme-y itself; run `uv lock` there',
    });
  });
});

describe('fixedGroupVersion', () => {
  const config = { fixed: [['@kindgi/*']] };
  const pkg = (name, version) => ({ name, version });

  test("is the group's one version", () => {
    const packages = [
      pkg('kindgi-sdk', '0.0.0'),
      pkg('@kindgi/sdk', '1.2.3'),
      pkg('@kindgi/cli', '1.2.3'),
      pkg('@other/x', '9.0.0'),
    ];
    assert.deepEqual(fixedGroupVersion(config, packages), {
      version: '1.2.3',
      group: ['@kindgi/*'],
      members: 2,
    });
  });

  test("refuses a group that doesn't agree, naming who differs", () => {
    const packages = [pkg('@kindgi/sdk', '1.2.3'), pkg('@kindgi/cli', '1.2.4')];
    assert.throws(() => fixedGroupVersion(config, packages), {
      message:
        "the fixed group (@kindgi/*) doesn't share one version: @kindgi/sdk is 1.2.3, but\n  - @kindgi/cli is 1.2.4",
    });
  });

  test('refuses no group, and patterns it can only guess at', () => {
    assert.throws(
      () => fixedGroupVersion({ fixed: [['@other/*']] }, [pkg('@kindgi/sdk', '1.0.0')]),
      /in no fixed group/,
    );
    assert.throws(
      () => fixedGroupVersion({ fixed: [['@kindgi/{sdk,cli}']] }, [pkg('@kindgi/sdk', '1.0.0')]),
      /only package names and `\*` wildcards/,
    );
  });
});

// ---- the command, in a scratch workspace ----------------------------------------

const PYPROJECT = `# SPDX-License-Identifier: Apache-2.0

[project]
name = "acme-x"
# The version follows the npm packages.
version = "1.2.0"
description = """
A fixture, with a line that looks like the version:
version = "0.0.1"
"""
requires-python = ">=3.11"
dependencies = []

[tool.acme]
version = "0.0.2"

[build-system]
requires = ["hatchling>=1.26"]
build-backend = "hatchling.build"
`;

const LOCK = `version = 1
revision = 3
requires-python = ">=3.11"

[[package]]
name = "acme-x"
version = "1.2.0"
source = { editable = "." }
`;

let fixtures = 0;

/** A workspace with two fixed-group packages and the Python project `sdks/python`. */
function workspace({ sdk, cli = sdk, python = '1.2.0' }) {
  const root = join(scratch, `ws-${++fixtures}`);
  const write = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  write('package.json', JSON.stringify({ name: 'acme-root', private: true }));
  write('pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n');
  write('.changeset/config.json', JSON.stringify({ fixed: [['@kindgi/*']] }));
  write('packages/sdk/package.json', JSON.stringify({ name: '@kindgi/sdk', version: sdk }));
  write('packages/cli/package.json', JSON.stringify({ name: '@kindgi/cli', version: cli }));
  write('sdks/python/pyproject.toml', PYPROJECT.replace('"1.2.0"', `"${python}"`));
  write('sdks/python/uv.lock', LOCK.replace('"1.2.0"', `"${python}"`));
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: root });
  return root;
}

/** Runs the command in `root`; offline, so uv never reaches an index. */
function run(root, args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, UV_OFFLINE: '1', ...env },
  });
}

const read = (root, file) => readFileSync(join(root, file), 'utf8');

describe('sync-python-version --check', () => {
  test('passes when pyproject.toml and uv.lock have the npm version', () => {
    const result = run(workspace({ sdk: '1.2.0' }), ['--check']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 Python project\(s\) at 1\.2\.0, in step with the 2 packages/);
  });

  test('fails on a project behind npm, naming both files', () => {
    const result = run(workspace({ sdk: '1.2.3' }), ['--check']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /sdks\/python\/pyproject\.toml: version 1\.2\.0, expected 1\.2\.3/);
    assert.match(result.stderr, /sdks\/python\/uv\.lock: acme-x 1\.2\.0, expected 1\.2\.3/);
  });

  test('compares the PEP 440 spelling of a prerelease', () => {
    assert.equal(run(workspace({ sdk: '2.0.0-rc.1', python: '2.0.0rc1' }), ['--check']).status, 0);
    const result = run(workspace({ sdk: '2.0.0-rc.1', python: '2.0.0' }), ['--check']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /version 2\.0\.0, expected 2\.0\.0rc1/);
  });

  test("fails when the fixed group doesn't agree", () => {
    const result = run(workspace({ sdk: '1.2.0', cli: '1.2.1' }), ['--check']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /@kindgi\/cli is 1\.2\.1/);
  });

  test('refuses an unknown argument', () => {
    const result = run(workspace({ sdk: '1.2.0' }), ['--chek']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown argument --chek; usage:/);
  });
});

describe('sync-python-version (writing)', () => {
  test('without uv, fails before it writes anything', () => {
    const root = workspace({ sdk: '1.2.3' });
    const result = run(root, [], { PATH: join(scratch, 'empty-path') });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /uv is not on PATH/);
    assert.equal(read(root, 'sdks/python/pyproject.toml'), PYPROJECT);
    assert.equal(read(root, 'sdks/python/uv.lock'), LOCK);
  });

  test(
    'sets the version and its lock entry, and changes nothing else',
    { skip: HAS_UV ? false : 'uv is not installed' },
    () => {
      const root = workspace({ sdk: '1.3.0-beta.2' });
      const result = run(root, []);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /sdks\/python \(acme-x\) 1\.2\.0 → 1\.3\.0b2/);
      assert.equal(
        read(root, 'sdks/python/pyproject.toml'),
        PYPROJECT.replace('version = "1.2.0"', 'version = "1.3.0b2"'),
      );
      assert.equal(
        lockedVersion(read(root, 'sdks/python/uv.lock'), 'acme-x', 'uv.lock'),
        '1.3.0b2',
      );
      assert.equal(run(root, ['--check']).status, 0);

      const again = run(root, []);
      assert.equal(again.status, 0, again.stderr);
      assert.match(again.stdout, /is already 1\.3\.0b2/);
    },
  );
});
