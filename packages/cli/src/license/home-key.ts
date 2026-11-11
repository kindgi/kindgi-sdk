// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The license key `kindgi dev` runs the runtime with, kept in the CLI's
 * home folder: `~/.kindgi/license/license-key`. `kindgi auth registry`
 * writes it once Docker has logged in to Kindgi's registry with it;
 * `kindgi dev` and `kindgi doctor` read it.
 *
 * Owner-only: the file `0600`, its folder and `~/.kindgi` `0700`. The
 * folder holds the license's files and nothing else, so it can be handed
 * to a container on its own, never `~/.kindgi` itself. It's never in the
 * project, where a coding agent reads: `<pack>/.kindgi/dev/runtime.env`
 * holds no key.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CommandContext } from '../context.js';
import { homeFolder } from '../home.js';
import { pickHome } from '../key/paths.js';
import { makePrivateDir, writePrivateFile } from '../private-file.js';

/** `~/.kindgi/license/license-key`, as it's said in messages. */
export const HOME_LICENSE_KEY_DISPLAY = '~/.kindgi/license/license-key';

/**
 * The home folder a command keeps the key under, or reads it from: `HOME`,
 * then the context's own (`pickHome`), so `kindgi auth registry` writes it
 * where `kindgi dev` and `kindgi doctor` look.
 */
export function licenseKeyHome(ctx: Pick<CommandContext, 'env' | 'home'>): string | undefined {
  const envHome = ctx.env.HOME;
  return pickHome({
    ...(ctx.home !== undefined && { ctxHome: ctx.home }),
    ...(envHome !== undefined && envHome !== '' && { envHome }),
  });
}

/** `<home>/.kindgi/license/license-key`; `undefined` with no home folder (`homeFolder`). */
export function homeLicenseKeyPath(home?: string): string | undefined {
  const folder = homeFolder(home);
  return folder === undefined ? undefined : join(folder, '.kindgi', 'license', 'license-key');
}

/** The kept key, trimmed: `undefined` with no home folder, no file, or an empty one. */
export async function readHomeLicenseKey(home?: string): Promise<string | undefined> {
  const path = homeLicenseKeyPath(home);
  if (path === undefined) return undefined;
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw cause;
  }
  const key = text.trim();
  return key === '' ? undefined : key;
}

/**
 * Keep `key` for `kindgi dev`: a new `0600` file that replaces the old
 * one in one step (`writePrivateFile`), in folders made `0700`. Its path.
 */
export async function saveHomeLicenseKey(key: string, home?: string): Promise<string> {
  const path = homeLicenseKeyPath(home);
  if (path === undefined) {
    throw new Error(
      `Found no home folder for ${HOME_LICENSE_KEY_DISPLAY}, since HOME is empty. Set HOME and run it again.`,
    );
  }
  await makePrivateDir(dirname(dirname(path)));
  await makePrivateDir(dirname(path));
  await writePrivateFile(path, `${key.trim()}\n`);
  return path;
}
