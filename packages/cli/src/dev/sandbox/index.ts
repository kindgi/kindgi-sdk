// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi dev` runs the pack's code sandboxed, in both processes that run
 * it: the pack service, and the indexer (which imports every primitive's
 * module, so runs its top-level code). The tool and module code a coding
 * agent writes can't read the user's keys, other projects, or the Docker
 * socket, and can't write outside the app. It still reaches the network,
 * and reads and writes the app's own files (but Kindgi's configuration).
 * The guide: https://docs.kindgi.com/v0.1/guides/secrets/dev-sandbox/.
 *
 * At every start, {@link sandboxedCommand} works out what this start runs
 * (the runtime, the dependencies: `policy.ts`), writes the sandbox for it
 * (macOS: a Seatbelt profile; Linux: bwrap's arguments and a wrapper), and
 * returns the command inside it.
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PackCode } from '../pack-code.js';
import { BWRAP_WRAPPER, appSecrets, bwrapArgs } from './bwrap.js';
import { SANDBOX_EXEC, type SandboxEngine } from './detect.js';
import { type SandboxPolicy, sandboxPolicy } from './policy.js';
import { seatbeltProfile } from './seatbelt.js';
import type { DevSandboxSettings } from './settings.js';

export {
  DEV_SANDBOX_DOCS,
  type SandboxAvailability,
  type SandboxEngine,
  detectDevSandbox,
} from './detect.js';
export {
  DEV_SANDBOX_VAR,
  type DevSandboxMode,
  type DevSandboxSettings,
  devSandboxSettings,
} from './settings.js';

/** The sandbox this `kindgi dev` runs the pack service in. */
export interface ActiveDevSandbox {
  readonly engine: SandboxEngine;
  readonly settings: DevSandboxSettings;
  /** The home folder it closes. */
  readonly home: string;
}

/** What the sandbox calls itself in `kindgi dev`'s output. */
export function sandboxLabel(engine: SandboxEngine): string {
  return engine === 'seatbelt' ? 'macOS Seatbelt' : 'bubblewrap';
}

/** The pack service's own temp folder on macOS: one per app, under the user's temp folder. */
export function sandboxTmpDir(packDir: string): string {
  const hash = createHash('sha256').update(packDir).digest('hex').slice(0, 12);
  let base = tmpdir();
  try {
    base = realpathSync(base);
  } catch {
    // The real path is only for the profile's match; the folder is made below.
  }
  return join(base, `kindgi-dev-${hash}`);
}

/** Which process runs inside: each gets its own profile file, so the two never share one mid-write. */
export type SandboxedProcess = 'pack-service' | 'indexer';

export interface SandboxedCommandOptions {
  readonly packDir: string;
  readonly code: PackCode;
  /** The command, unsandboxed. */
  readonly command: readonly [string, ...string[]];
  /** Its environment. */
  readonly env: Readonly<Record<string, string>>;
  /** Node: the binary and the entrypoint (the pack service's, or the indexer child's). */
  readonly node: { readonly execPath: string; readonly entry: string };
  /** Default `pack-service`. */
  readonly process?: SandboxedProcess;
  /** Folders inside the app's `.kindgi` it may write (made here if missing). */
  readonly writable?: readonly string[];
  /** A notice for the user: a root left out because it holds the home folder, a search cut short. */
  readonly onNotice?: (line: string) => void;
}

export interface SandboxedCommand {
  readonly command: readonly [string, ...string[]];
  readonly policy: SandboxPolicy;
}

export async function sandboxedCommand(
  sandbox: ActiveDevSandbox,
  opts: SandboxedCommandOptions,
): Promise<SandboxedCommand> {
  const tmpDir = sandbox.engine === 'seatbelt' ? sandboxTmpDir(opts.packDir) : '/tmp';
  if (sandbox.engine === 'seatbelt') await mkdir(tmpDir, { recursive: true, mode: 0o700 });
  for (const dir of opts.writable ?? []) await mkdir(dir, { recursive: true });
  const which = opts.process ?? 'pack-service';
  const policy = await sandboxPolicy({
    packDir: opts.packDir,
    home: sandbox.home,
    code: opts.code,
    settings: sandbox.settings,
    tmpDir,
    env: opts.env,
    node: opts.node,
    ...(opts.writable !== undefined && { writable: opts.writable }),
  });
  for (const root of policy.skipped) {
    opts.onNotice?.(
      `dev sandbox: not opening ${root}: it holds your home folder, which stays closed`,
    );
  }
  const devDir = join(opts.packDir, '.kindgi', 'dev');
  await mkdir(devDir, { recursive: true });
  if (sandbox.engine === 'seatbelt') {
    const profile = join(devDir, which === 'indexer' ? 'sandbox-indexer.sb' : 'sandbox.sb');
    await writeFile(profile, seatbeltProfile(policy), { mode: 0o600 });
    return { command: [SANDBOX_EXEC, '-f', profile, ...opts.command], policy };
  }
  const wrapper = join(devDir, 'kindgi-dev-sandbox');
  await writeFile(wrapper, BWRAP_WRAPPER, { mode: 0o755 });
  await chmod(wrapper, 0o755);
  const secrets = await appSecrets(policy.app);
  if (secrets.truncated) {
    opts.onNotice?.(
      'dev sandbox: the app is too large to search for secret files in full; files such as .env further down stay readable',
    );
  }
  const args = bwrapArgs(policy, secrets);
  return { command: ['sh', wrapper, ...args, '--', ...opts.command], policy };
}
