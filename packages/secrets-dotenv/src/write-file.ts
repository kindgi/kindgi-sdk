// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** Writing an env file: atomically, with the mode it should keep. */

import { chmod, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Kindgi's own secrets file, and a new file, are owner-only. */
export const SECRETS_FILE_MODE = 0o600;

/** A file's permission bits, or 0600 for a file that doesn't exist yet. */
export async function existingMode(file: string): Promise<number> {
  try {
    return (await stat(file)).mode & 0o777;
  } catch {
    return SECRETS_FILE_MODE;
  }
}

/** Write-tmp + rename, then `mode` (chmod again: the temp file's mode passes through the umask). */
export async function writeAtomic(target: string, contents: string, mode: number): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, contents, { mode });
  await rename(tmp, target);
  await chmod(target, mode);
}
