// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Real file-system events for watcher tests. Which events a watcher acts
 * on is tested with scripted events; these tests check only that the
 * system's events reach it, and tell a slow machine from a broken watcher.
 */

import { watch } from 'node:fs';

import { folderGoneWhileRead } from '../src/dev/shared-watch.js';

/**
 * How long to wait for the system to report a change at all. macOS's event
 * daemon can fall far behind on a busy machine, and drops events when it
 * does, so the change is made again every round until one is reported.
 */
const SYSTEM_REPORTS_WITHIN_MS = 30_000;

/**
 * Once the system has reported the change, how long the watcher under test
 * may take to pass it on, including any work it does first (a build).
 */
const PASSED_ON_WITHIN_MS = 20_000;

/**
 * Make `change` every round until `reported()`, beside a plain
 * `fs.watch` of the same folder that looks for the change's `name`. That
 * one is the control: once the system has reported the change to it, the
 * watcher under test must pass it on. When the system reports nothing at all
 * (its event service far behind, as macOS's gets on a busy machine), the
 * test is skipped and says so: that's the machine, not the watcher.
 */
export async function untilReported(
  context: { skip(): void },
  watched: { readonly folder: string; readonly recursive: boolean; readonly name: string },
  reported: () => boolean,
  change: () => Promise<void>,
): Promise<void> {
  let reportedAt: number | undefined;
  const control = watch(watched.folder, { recursive: watched.recursive }, (_event, filename) => {
    if (filename === watched.name) reportedAt ??= Date.now();
  });
  // On Linux, Node's recursive watch emits an 'error' for a folder removed
  // while it's reading it, and goes on; the control needs only the change's
  // name. Any other error is a failed control: it would report nothing, and
  // the test would be skipped as if the machine were slow.
  let failed: unknown;
  control.on('error', (error) => {
    if (!folderGoneWhileRead(error)) failed ??= error;
  });
  const giveUpAt = Date.now() + SYSTEM_REPORTS_WITHIN_MS;
  try {
    while (!reported()) {
      if (failed !== undefined) {
        throw new Error(
          `the control watch failed: ${failed instanceof Error ? failed.message : String(failed)}`,
          { cause: failed },
        );
      }
      if (reportedAt !== undefined && Date.now() > reportedAt + PASSED_ON_WITHIN_MS) {
        throw new Error(
          `the system reported ${watched.name} ${Date.now() - reportedAt} ms ago; the watcher under test hasn't`,
        );
      }
      if (reportedAt === undefined && Date.now() > giveUpAt) {
        console.warn(
          `skipped: the system reported no change to ${watched.folder} in ${SYSTEM_REPORTS_WITHIN_MS} ms`,
        );
        context.skip();
      }
      await change();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    control.close();
  }
}
