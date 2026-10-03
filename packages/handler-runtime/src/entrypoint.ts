// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Whether the module at `moduleUrl` is the process entrypoint (`node <file>`).
 *
 * Node resolves symlinks for the main module's `import.meta.url` but leaves
 * `process.argv[1]` as given, so the two are compared through the real path:
 * a package started through `node_modules/@kindgi/…` (a pnpm symlink) still
 * runs its `main()`.
 */
export function isProcessEntrypoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}
