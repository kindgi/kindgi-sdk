// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `scripts/pack-tarball.mjs`: packs of one package at once never meet (T395: two
 * `attw --pack` runs on a package shared one tarball in its folder, and one deleted it under the
 * other), and nothing is left behind.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { withOwnTarball } from './pack-tarball.mjs';

const pkg = mkdtempSync(join(tmpdir(), 'kindgi-pack-test-'));
writeFileSync(
  join(pkg, 'package.json'),
  JSON.stringify({ name: '@acme/fixture', version: '1.0.0', files: ['index.js'] }),
);
writeFileSync(join(pkg, 'index.js'), 'export const answer = 42;\n');
after(() => rmSync(pkg, { recursive: true, force: true }));

describe('withOwnTarball', () => {
  test('four packs of one package at once: each its own tarball, there for the whole use, all removed after', async () => {
    const seen = await Promise.all(
      Array.from({ length: 4 }, () =>
        withOwnTarball(pkg, async (tarball) => {
          // Overlap the uses, as the parallel attw runs do.
          await sleep(100);
          assert.ok(statSync(tarball).size > 0, `${tarball} is there while it's used`);
          return tarball;
        }),
      ),
    );
    assert.equal(new Set(seen).size, 4, 'four different tarballs');
    for (const tarball of seen) {
      assert.match(tarball, /acme-fixture-1\.0\.0\.tgz$/);
      assert.equal(existsSync(dirname(tarball)), false, `${dirname(tarball)} is removed`);
    }
    assert.deepEqual(
      readdirSync(pkg).filter((f) => f.endsWith('.tgz')),
      [],
      "nothing packed into the package's folder",
    );
  });

  test('a use that throws: the error comes through, and the directory is removed', async () => {
    let dir;
    await assert.rejects(
      withOwnTarball(pkg, async (tarball) => {
        dir = dirname(tarball);
        throw new Error('attw failed');
      }),
      /attw failed/,
    );
    assert.equal(existsSync(dir), false);
  });
});
