// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Writing a file a command was asked for (`kindgi artifacts download`,
 * `kindgi corrections export`): it's written beside its name first, and
 * takes the name only once it's whole.
 */

import { access, link, rename } from 'node:fs/promises';

/** Whether something is at `path`. */
export const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/** What `link` answers on a file system with no hard links. */
const NO_HARD_LINKS: ReadonlySet<string> = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

/**
 * Without --force, `partial` takes `target`'s name only while nothing has
 * it, a file that turned up there during the download included: `link`
 * refuses a name that's taken in one step. Where the file system has no
 * hard links, `target` is looked for again right before the rename.
 * `refuse` is the error for a name that's taken, naming the command's own
 * flags.
 */
export async function placeNew(
  partial: string,
  target: string,
  refuse: () => Error,
): Promise<void> {
  try {
    await link(partial, target);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw refuse();
    if (code === undefined || !NO_HARD_LINKS.has(code)) throw err;
  }
  if (await exists(target)) throw refuse();
  await rename(partial, target);
}
