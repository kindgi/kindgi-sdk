// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Tests for `scripts/wordpress-plugin-zip.mjs`: the plugin's version, what
 * goes in its zip, and the zip itself, built twice from this checkout.
 * Run: `pnpm run test:scripts`.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import {
  buildZip,
  checkStableTag,
  checksumLine,
  pluginVersion,
  zipEntries,
} from './wordpress-plugin-zip.mjs';

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const header = (version, constant = version) =>
  [
    '<?php',
    '/**',
    ' * Plugin Name:       Kindgi',
    ` * Version:           ${version}`,
    ' */',
    `define( 'KINDGI_PLUGIN_VERSION', '${constant}' );`,
  ].join('\n');

describe('pluginVersion', () => {
  test("the header's version, when the constant is the same", () => {
    assert.equal(pluginVersion(header('0.1.0')), '0.1.0');
    assert.equal(pluginVersion(header('1.2.3-rc.1')), '1.2.3-rc.1');
  });

  test('refuses a header and a constant that differ, naming both', () => {
    assert.throws(
      () => pluginVersion(header('0.2.0', '0.1.0')),
      /header is 0\.2\.0 but KINDGI_PLUGIN_VERSION is 0\.1\.0/,
    );
  });

  test('refuses a file with no header, no constant, or a version that is not X.Y.Z', () => {
    assert.throws(
      () => pluginVersion("define( 'KINDGI_PLUGIN_VERSION', '0.1.0' );"),
      /no `Version:` header/,
    );
    assert.throws(() => pluginVersion(' * Version: 0.1.0'), /defines no KINDGI_PLUGIN_VERSION/);
    assert.throws(() => pluginVersion(header('0.1')), /isn't X\.Y\.Z/);
  });
});

describe('checkStableTag', () => {
  const readme = (tag) =>
    ['=== Kindgi ===', 'Contributors: acme', `Stable tag: ${tag}`, ''].join('\n');

  test("passes when readme.txt's Stable tag is the plugin's version", () => {
    assert.doesNotThrow(() => checkStableTag(readme('0.1.0'), '0.1.0'));
    assert.doesNotThrow(() => checkStableTag(readme('0.1.0  '), '0.1.0'));
  });

  test('refuses a Stable tag that differs, naming both, and trunk', () => {
    assert.throws(
      () => checkStableTag(readme('0.1.0'), '0.2.0'),
      /Stable tag is 0\.1\.0 but kindgi\.php's version is 0\.2\.0/,
    );
    assert.throws(() => checkStableTag(readme('trunk'), '0.1.0'), /Stable tag is trunk/);
  });

  test('refuses a readme.txt with no Stable tag', () => {
    assert.throws(() => checkStableTag('=== Kindgi ===\n', '0.1.0'), /no `Stable tag:`/);
  });
});

describe('zipEntries', () => {
  test('the plugin less its tests and dot files, the license files, and each folder before what it holds', () => {
    assert.deepEqual(
      zipEntries([
        'kindgi.php',
        'includes/class-kindgi-api.php',
        'tests/run.php',
        '.gitattributes',
        'assets/.keep',
        'assets/kindgi-admin.js',
      ]),
      [
        'kindgi/',
        'kindgi/LICENSE',
        'kindgi/NOTICE',
        'kindgi/assets/',
        'kindgi/assets/kindgi-admin.js',
        'kindgi/includes/',
        'kindgi/includes/class-kindgi-api.php',
        'kindgi/kindgi.php',
      ],
    );
  });

  test("refuses a plugin with its own LICENSE: the zip takes the repository's", () => {
    assert.throws(() => zipEntries(['kindgi.php', 'LICENSE']), /its own LICENSE/);
  });
});

test('checksumLine is the line sha256sum writes', () => {
  assert.equal(
    checksumLine('kindgi-0.1.0.zip', Buffer.from('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  kindgi-0.1.0.zip\n',
  );
});

describe('buildZip, from this checkout', () => {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const build = () => {
    const out = mkdtempSync(join(tmpdir(), 'kindgi-plugin-zip-'));
    dirs.push(out);
    return buildZip(root, out);
  };

  test('the zip has what zipEntries lists, under one kindgi/ folder, and no tests', () => {
    const { version, zip, entries } = build();
    assert.ok(zip.endsWith(`/kindgi-${version}.zip`));
    const listed = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(listed, entries);
    assert.ok(listed.includes('kindgi/kindgi.php'));
    assert.ok(listed.includes('kindgi/LICENSE'));
    assert.ok(listed.includes('kindgi/readme.txt'));
    assert.ok(
      listed.every((path) => path.startsWith('kindgi/') && !path.startsWith('kindgi/tests/')),
    );
  });

  test("every entry is dated the commit's time, in UTC", () => {
    const { zip } = build();
    const committed = Number(
      execFileSync('git', ['log', '-1', '--format=%ct', 'HEAD'], { cwd: root, encoding: 'utf8' }),
    );
    // A zip keeps even seconds: Info-ZIP rounds an odd one up.
    const at = new Date((committed + (committed % 2)) * 1000);
    const two = (n) => String(n).padStart(2, '0');
    const want = `${at.getUTCFullYear()}${two(at.getUTCMonth() + 1)}${two(at.getUTCDate())}.${two(at.getUTCHours())}${two(at.getUTCMinutes())}${two(at.getUTCSeconds())}`;
    const dates = execFileSync('unzip', ['-Z', '-T', zip], {
      encoding: 'utf8',
      env: { ...process.env, TZ: 'UTC' },
    })
      .split('\n')
      .map((line) => /\s(\d{8}\.\d{6})\s/.exec(line)?.[1])
      .filter((date) => date !== undefined);
    assert.ok(dates.length > 0);
    assert.deepEqual([...new Set(dates)], [want]);
  });

  test('the checksum file checks the zip, and a second build has the same checksum', () => {
    const first = build();
    const second = build();
    const line = readFileSync(first.sha256, 'utf8');
    assert.equal(line, checksumLine(`kindgi-${first.version}.zip`, readFileSync(first.zip)));
    assert.equal(readFileSync(second.sha256, 'utf8'), line);
  });
});
