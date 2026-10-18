// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A scripted `fs.watch` for the pack builders' tests: it reports only what
 * the test emits on it. It's an `EventEmitter`, as Node's watcher is, so an
 * 'error' the builder doesn't listen for throws, as it would in `kindgi dev`.
 */

import { EventEmitter } from 'node:events';
import type { watch } from 'node:fs';

export class ScriptedWatcher extends EventEmitter {
  /** Whether the builder closed it. */
  closed = false;

  close(): void {
    this.closed = true;
  }
}

/** `watchFs` for a builder, and the watcher it hands out (its listener on 'change'). */
export function scriptedWatch(): {
  readonly watchFs: typeof watch;
  readonly watcher: ScriptedWatcher;
} {
  const watcher = new ScriptedWatcher();
  const watchFs = ((_path: string, _options: unknown, listener?: (...args: unknown[]) => void) => {
    if (listener !== undefined) watcher.on('change', listener);
    return watcher;
  }) as unknown as typeof watch;
  return { watchFs, watcher };
}

/**
 * The error Node's recursive watch emits on Linux when a folder it watches
 * is removed while it's reading it: between its `stat` and its `readdir`,
 * as an `rm -r` running beside it does. The watch goes on.
 */
export function removedWhileRead(folder: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, scandir '${folder}'`), {
    errno: -2,
    code: 'ENOENT',
    syscall: 'scandir',
    path: folder,
  });
}
