// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A package packed into a directory of its own, for a tool that reads the
 * tarball (`check-publish.mjs`'s are-the-types-wrong runs).
 *
 * `attw --pack <dir>` runs `npm pack` in the package's folder, reads the
 * tarball by its fixed name and deletes it. Two runs on one package at once
 * (a package with programs gets two) share that file, and one deletes it
 * under the other: `ENOENT … unlink …/<name>-<version>.tgz` (T395). Here each
 * pack has its own temporary directory, removed after, so packs of one
 * package never meet and nothing is left in the package's folder.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Pack `packageDir` (`npm pack`, as `attw --pack` does) into a new
 * temporary directory and call `use` with the tarball's path. The directory
 * is removed when `use` settles, whether it resolves or throws.
 *
 * @template T
 * @param {string} packageDir
 * @param {(tarball: string) => Promise<T>} use
 * @returns {Promise<T>}
 */
export async function withOwnTarball(packageDir, use) {
  const dir = await mkdtemp(join(tmpdir(), 'kindgi-pack-'));
  try {
    await run('npm', ['pack', '--pack-destination', dir], {
      cwd: packageDir,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    // The directory is new, so its one tarball is this pack's (whatever a
    // prepack script printed).
    const tarballs = (await readdir(dir)).filter((name) => name.endsWith('.tgz'));
    if (tarballs.length !== 1) {
      throw new Error(`npm pack in ${packageDir} left ${tarballs.length} tarballs in ${dir}`);
    }
    return await use(join(dir, tarballs[0]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
