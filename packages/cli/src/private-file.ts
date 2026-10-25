// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A file that holds a key or token, such as `~/.kindgi/config.json`:
 * owner-only from its first byte, whatever mode an older one had.
 */

import { randomBytes } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';

const PRIVATE_FILE_MODE = 0o600;

/**
 * Replace `path` with `text` in one step: a new `0600` file beside it, then
 * a rename (`license/stores.ts`'s way). A reader that opened the old file
 * keeps reading the old text, and a crash leaves the old file or the new
 * one whole. A symlink at `path` becomes a file.
 *
 * The umask can only take bits from `0600`, so the new file is never
 * looser; a filesystem with no modes still gets the file. Windows has no
 * such modes, and a rename there can fail while another program has the
 * file open: the write there is in place, as before.
 */
export async function writePrivateFile(path: string, text: string): Promise<void> {
  if (process.platform === 'win32') {
    await writeFile(path, text, 'utf8');
    return;
  }
  const temp = `${path}.${randomBytes(6).toString('hex')}.kindgi-tmp`;
  try {
    await writeFile(temp, text, { encoding: 'utf8', mode: PRIVATE_FILE_MODE, flag: 'wx' });
    await rename(temp, path);
  } catch (cause) {
    await unlink(temp).catch(() => undefined);
    throw cause;
  }
}
