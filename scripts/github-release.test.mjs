// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Tests for `scripts/github-release.mjs`: the release's tag, its notes, and
 * the `gh` calls that make or update it. Run: `pnpm run test:scripts`.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { docsBase, ghCalls, releaseNotes, releaseTag } from './github-release.mjs';

const PLUGIN = { version: '0.1.0', wordpress: '6.4', php: '7.4' };

test("the release goes on @kindgi/sdk's tag, and links its release line's docs", () => {
  assert.equal(releaseTag('0.1.9'), '@kindgi/sdk@0.1.9');
  assert.equal(docsBase('0.1.9'), 'https://docs.kindgi.com/v0.1');
  assert.equal(docsBase('0.2.0-rc.1'), 'https://docs.kindgi.com/v0.2');
});

describe('releaseNotes', () => {
  const notes = releaseNotes({ version: '0.1.9', plugin: PLUGIN });

  test("name the SDK's version, and the plugin's zip at the plugin's own version", () => {
    assert.match(notes, /^The Kindgi SDK 0\.1\.9\. /);
    assert.match(notes, /^## The WordPress plugin 0\.1\.0$/m);
    assert.match(notes, /`kindgi-0\.1\.0\.zip` is the Kindgi plugin for WordPress/);
  });

  test('say how to check the download, what it needs, and where the guide is', () => {
    assert.match(notes, /`sha256sum -c kindgi-0\.1\.0\.zip\.sha256`/);
    assert.match(notes, /`shasum -a 256 -c kindgi-0\.1\.0\.zip\.sha256`/);
    assert.match(notes, /WordPress 6\.4 or later and PHP 7\.4 or later/);
    // WordPress 6.8's menu, and the one before it back to 6.4, the least the plugin needs.
    assert.match(
      notes,
      /\*\*Plugins → Add Plugin → Upload Plugin\*\* \(\*\*Add New Plugin\*\* before WordPress 6\.8\)/,
    );
    assert.match(notes, /https:\/\/docs\.kindgi\.com\/v0\.1\/sites\/wordpress\//);
  });
});

describe('ghCalls', () => {
  const files = ['out/kindgi-0.1.0.zip', 'out/kindgi-0.1.0.zip.sha256'];

  test('a new release: made on its tag (which must be there), as the latest', () => {
    assert.deepEqual(ghCalls({ version: '0.1.9', exists: false, files, notesFile: 'notes.txt' }), [
      [
        'release',
        'create',
        '@kindgi/sdk@0.1.9',
        ...files,
        '--verify-tag',
        '--title',
        'Kindgi SDK 0.1.9',
        '--notes-file',
        'notes.txt',
        '--latest',
      ],
    ]);
  });

  test('a release candidate: a pre-release, never the latest', () => {
    const [create] = ghCalls({
      version: '0.1.9-rc.0',
      exists: false,
      files,
      notesFile: 'notes.txt',
    });
    assert.deepEqual(create.slice(-2), ['--prerelease', '--latest=false']);
    const [edit] = ghCalls({ version: '0.1.9-rc.0', exists: true, files, notesFile: 'notes.txt' });
    assert.deepEqual(edit.slice(-2), ['--prerelease', '--latest=false']);
  });

  test("a release that's there: its title and notes edited, its files replaced", () => {
    assert.deepEqual(ghCalls({ version: '0.1.9', exists: true, files, notesFile: 'notes.txt' }), [
      [
        'release',
        'edit',
        '@kindgi/sdk@0.1.9',
        '--title',
        'Kindgi SDK 0.1.9',
        '--notes-file',
        'notes.txt',
        '--prerelease=false',
        '--latest',
      ],
      ['release', 'upload', '@kindgi/sdk@0.1.9', ...files, '--clobber'],
    ]);
  });
});
