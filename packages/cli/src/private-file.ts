// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A file that holds a key or token, such as `~/.kindgi/config.json`:
 * owner-only from its first byte, whatever mode an older one had.
 */

import { randomBytes } from 'node:crypto';
import { realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';

const PRIVATE_FILE_MODE = 0o600;

/**
 * Replace `path` with `text` in one step: a new `0600` file beside it, then
 * a rename (`license/stores.ts`'s way). A reader that opened the old file
 * keeps reading the old text, and a crash leaves the old file or the new
 * one whole. A symlink at `path` stays: the file it points to is the one
 * replaced, so the old text doesn't stay there at its old mode. A link
 * that points nowhere becomes a file. Only a regular file is replaced: one
 * that's a device, a pipe or a socket (a link to `/dev/null`) is refused,
 * and left as it is.
 *
 * The umask can only take bits from `0600`, so the new file is never
 * looser; a filesystem with no modes still gets the file. On Windows too,
 * where the rename fails while another program has the file open, and the
 * old file stays whole.
 */
export async function replacePrivateFile(path: string, text: string): Promise<void> {
  let target = path;
  try {
    target = await realpath(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
  // The rename would put a file in place of whatever is there.
  const found = await stat(target).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw cause;
  });
  if (found !== undefined && !found.isFile()) {
    throw new Error(`${target} isn't a regular file, so it was left as it is.`);
  }
  const temp = `${target}.${randomBytes(6).toString('hex')}.kindgi-tmp`;
  try {
    await writeFile(temp, text, { encoding: 'utf8', mode: PRIVATE_FILE_MODE, flag: 'wx' });
    await rename(temp, target);
  } catch (cause) {
    await unlink(temp).catch(() => undefined);
    throw cause;
  }
}

/**
 * `replacePrivateFile`, except on Windows: it has no such modes, and a
 * rename there can fail while another program has the file open, so the
 * write there is in place.
 */
export async function writePrivateFile(path: string, text: string): Promise<void> {
  if (process.platform === 'win32') {
    await writeFile(path, text, 'utf8');
    return;
  }
  await replacePrivateFile(path, text);
}
