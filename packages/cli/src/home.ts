// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { homedir } from 'node:os';

/**
 * The home folder: `home` when it names one, else `os.homedir()`.
 * `undefined` when neither does: with `HOME` set but empty, `os.homedir()`
 * answers '', and `~/.kindgi/` would resolve under the current folder.
 * A command that keeps or reads files there refuses then, or reads none.
 */
export function homeFolder(home?: string): string | undefined {
  const folder = home !== undefined && home !== '' ? home : homedir();
  return folder === '' ? undefined : folder;
}
