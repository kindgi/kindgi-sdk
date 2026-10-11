// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What `kindgi dev` says about the sandbox at start, and whether it starts:
 *
 * - on, and this machine can: one line naming it, then each path or
 *   socket `dev.sandbox` opens;
 * - on, and it can't: a warning, loud and once, with why and what would
 *   fix it; the pack service runs without;
 * - required, and it can't: a refusal, before anything starts;
 * - off: one line saying so.
 *
 * On, with more than one Kindgi configuration in the app, it refuses: the
 * code it runs can't change the one in use, but bubblewrap can't stop it
 * adding another by a name looked up first, which the next start would
 * load outside the sandbox.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { KINDGI_CONFIG_FILENAMES } from '@kindgi/handler-runtime';

import type { PackConfigRecord } from '../../pack-config.js';
import { DEV_SANDBOX_DOCS, type SandboxAvailability } from './detect.js';
import { type ActiveDevSandbox, sandboxLabel } from './index.js';
import { DEV_SANDBOX_VAR, devSandboxSettings } from './settings.js';

export type DevSandboxOutcome =
  | {
      readonly kind: 'ok';
      /** The sandbox the pack service runs in; absent, none. */
      readonly sandbox: ActiveDevSandbox | undefined;
      /** What to print, in order. */
      readonly lines: readonly string[];
    }
  | { readonly kind: 'error'; readonly message: string };

export async function resolveDevSandbox(opts: {
  readonly config: PackConfigRecord | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly packDir: string;
  readonly home: string;
  readonly detect: () => Promise<SandboxAvailability>;
}): Promise<DevSandboxOutcome> {
  const settings = devSandboxSettings(opts.config, opts.env, {
    packDir: opts.packDir,
    home: opts.home,
  });
  if (settings.kind === 'invalid') return { kind: 'error', message: settings.message };
  const { mode, source, allowRead, allowUnixSockets } = settings.value;
  if (mode === 'off') {
    const why = source === 'env' ? `${DEV_SANDBOX_VAR}=off` : '`dev.sandbox: false` in the config';
    return {
      kind: 'ok',
      sandbox: undefined,
      lines: [
        `⚠ dev sandbox: off (${why}): your tools' code can read your files and keys as you can`,
      ],
    };
  }
  const availability = await opts.detect();
  if (availability.kind === 'unavailable') {
    if (mode === 'required') {
      return {
        kind: 'error',
        message: `the dev sandbox is required (${DEV_SANDBOX_VAR}=required), and can't run here: ${availability.reason}. ${availability.fix}`,
      };
    }
    return {
      kind: 'ok',
      sandbox: undefined,
      lines: [
        '⚠ Your tools run without the dev sandbox on this system: they can read your files and keys.',
        `  Why: ${availability.reason}. ${availability.fix}`,
        `  More: ${DEV_SANDBOX_DOCS}. To refuse to run without it: ${DEV_SANDBOX_VAR}=required; to drop this warning: ${DEV_SANDBOX_VAR}=off.`,
      ],
    };
  }
  const configs = kindgiConfigFiles(opts.packDir);
  if (configs.length > 1) {
    return {
      kind: 'error',
      message: `more than one Kindgi configuration in ${opts.packDir}: ${configs.join(', ')}. With the dev sandbox on, kindgi dev starts with one only: the code it runs can't change it, but could add another by a name looked up first. Keep the one you use and remove the others.`,
    };
  }
  const sandbox: ActiveDevSandbox = {
    engine: availability.engine,
    settings: settings.value,
    home: opts.home,
  };
  return {
    kind: 'ok',
    sandbox,
    lines: [
      `✓ dev sandbox: ${sandboxLabel(availability.engine)}: your tools' code can't read your keys or files outside the app, write outside it, or reach Docker; it still has the network and the app's own files`,
      ...allowRead.map((p) => `  also reads ${p} (dev.sandbox.allowRead)`),
      ...allowUnixSockets.map((p) => `  also connects to ${p} (dev.sandbox.allowUnixSockets)`),
    ],
  };
}

/** The Kindgi configuration files in the app: `kindgi.config.*`, `kindgi.config.json`, a `pyproject.toml` with `[tool.kindgi]`. */
export function kindgiConfigFiles(packDir: string): string[] {
  const found = [...KINDGI_CONFIG_FILENAMES, 'kindgi.config.json'].filter((name) =>
    existsSync(join(packDir, name)),
  );
  const pyproject = join(packDir, 'pyproject.toml');
  try {
    if (/^\[tool\.kindgi[\].]/m.test(readFileSync(pyproject, 'utf8'))) found.push('pyproject.toml');
  } catch {
    // No pyproject.toml.
  }
  return found;
}
