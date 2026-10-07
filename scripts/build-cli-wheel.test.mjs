// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Tests for `scripts/build-cli-wheel.mjs`: what the kindgi-cli wheel packs
 * from the workspace, its third-party notices, and the license allow-list.
 * Run: `pnpm run test:scripts`. (The build itself runs in CI's wheel step.)
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { disallowedLicenses, thirdPartyNotices, workspaceClosure } from './build-cli-wheel.mjs';

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function nodeModules(packages) {
  const root = mkdtempSync(join(tmpdir(), 'kindgi-notices-'));
  dirs.push(root);
  for (const [path, { manifest, files = {} }] of Object.entries(packages)) {
    const dir = join(root, path);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  }
  return root;
}

describe('workspaceClosure', () => {
  test("the CLI and the workspace packages it depends on, transitively; never a registry package's", () => {
    const manifests = new Map([
      ['@kindgi/cli', { dependencies: { '@kindgi/sdk': 'workspace:*', yaml: '^2' } }],
      ['@kindgi/sdk', { dependencies: { '@kindgi/types': 'workspace:*' } }],
      ['@kindgi/types', {}],
      ['@kindgi/adapter-x', { dependencies: { '@kindgi/types': 'workspace:*' } }],
    ]);
    assert.deepEqual(workspaceClosure('@kindgi/cli', manifests), [
      '@kindgi/cli',
      '@kindgi/sdk',
      '@kindgi/types',
    ]);
  });
});

describe('thirdPartyNotices', () => {
  test('every package (scoped and nested too) with its license and license files', () => {
    const root = nodeModules({
      yaml: {
        manifest: { name: 'yaml', version: '2.9.1', license: 'ISC' },
        files: { LICENSE: 'ISC text' },
      },
      '@kindgi/cli': {
        manifest: { name: '@kindgi/cli', version: '0.1.3', license: 'Apache-2.0' },
        files: { 'LICENSE.txt': 'Apache text', NOTICE: 'Kindgi notice' },
      },
      'tar/node_modules/minipass': {
        manifest: { name: 'minipass', version: '7.1.2', license: 'ISC' },
        files: { 'LICENSE.txt': 'minipass text' },
      },
      tar: {
        manifest: { name: 'tar', version: '7.5.0', license: 'BlueOak-1.0.0' },
        files: { LICENCE: 'tar text' },
      },
      'drizzle-orm': {
        manifest: {
          name: 'drizzle-orm',
          version: '0.45.3',
          license: 'Apache-2.0',
          author: 'Drizzle Team',
        },
      },
    });
    const text = thirdPartyNotices(root);
    for (const head of [
      '@kindgi/cli@0.1.3  (Apache-2.0)',
      'drizzle-orm@0.45.3  (Apache-2.0)',
      'minipass@7.1.2  (ISC)',
      'tar@7.5.0  (BlueOak-1.0.0)',
      'yaml@2.9.1  (ISC)',
    ]) {
      assert.ok(text.includes(head), head);
    }
    assert.ok(text.includes('Apache text\n\nKindgi notice'));
    assert.ok(text.includes('minipass text'));
    assert.ok(
      text.includes(
        "The package ships no license file. It is licensed Apache-2.0 by Drizzle Team; the license's terms: https://spdx.org/licenses/Apache-2.0.html",
      ),
    );
    // Sorted by package.
    assert.ok(text.indexOf('@kindgi/cli@') < text.indexOf('yaml@'));
  });
});

describe('disallowedLicenses', () => {
  test('permissive licenses pass; anything else is named', () => {
    const root = nodeModules({
      ok: { manifest: { name: 'ok', version: '1.0.0', license: 'MIT' } },
      either: { manifest: { name: 'either', version: '1.0.0', license: '(MIT OR CC0-1.0)' } },
      gpl: { manifest: { name: 'gpl', version: '2.0.0', license: 'GPL-3.0-only' } },
      none: { manifest: { name: 'none', version: '1.0.0' } },
    });
    assert.deepEqual(disallowedLicenses(root), [
      'gpl@2.0.0 (GPL-3.0-only)',
      'none@1.0.0 (UNKNOWN)',
    ]);
  });
});
