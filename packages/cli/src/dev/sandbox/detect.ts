// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Whether this machine can sandbox the pack service, and with what:
 * macOS's Seatbelt (`sandbox-exec`), or Linux's bubblewrap (`bwrap`,
 * the system's). Each is tried once with an empty policy, so the answer
 * is what happens, not a guess:
 *
 * - `sandbox-exec` refuses inside a process that is already sandboxed by a
 *   profile that restricts anything (`sandbox_apply: Operation not
 *   permitted`): a coding agent's sandbox around `kindgi dev`.
 * - `bwrap` needs unprivileged user namespaces. Ubuntu 23.10 and later
 *   restrict them with AppArmor (`setting up uid map: Permission
 *   denied`); a default Docker container doesn't allow them (`Creating
 *   new namespace failed: Operation not permitted`).
 * - Windows has none `kindgi dev` can use: under WSL, the Linux one.
 */

import { spawn } from 'node:child_process';

import { docsUrl } from '@kindgi/client/sso-handoff';

import { CLI_VERSION } from '../../version-info.js';

/** The page that says how to set the sandbox up, and what it does, on this CLI's release line. */
export const DEV_SANDBOX_DOCS = docsUrl('guides/secrets/dev-sandbox/', CLI_VERSION);

export type SandboxEngine = 'seatbelt' | 'bwrap';

export type SandboxAvailability =
  | { readonly kind: 'available'; readonly engine: SandboxEngine }
  | {
      readonly kind: 'unavailable';
      /** Why, in a phrase: "bubblewrap (bwrap) isn't installed". */
      readonly reason: string;
      /** What would make it work, in a sentence. */
      readonly fix: string;
    };

/** A finished process: its exit code (`null` when it didn't start) and stderr. */
export interface ProbeResult {
  readonly code: number | null;
  readonly stderr: string;
  /** The spawn error's code when it didn't start (`ENOENT`). */
  readonly errorCode?: string;
}

export type ProbeRunner = (program: string, args: readonly string[]) => Promise<ProbeResult>;

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** Run a probe to its end: its exit code and stderr, or why it didn't start. */
export function probeReal(program: string, args: readonly string[]): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(program, [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (err: NodeJS.ErrnoException) =>
      resolve({
        code: null,
        stderr: err.message,
        ...(err.code !== undefined && { errorCode: err.code }),
      }),
    );
    child.once('close', (code) => resolve({ code, stderr }));
  });
}

export async function detectDevSandbox(
  platform: NodeJS.Platform,
  run: ProbeRunner,
): Promise<SandboxAvailability> {
  if (platform === 'darwin') {
    return seatbeltAvailability(
      await run(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true']),
    );
  }
  if (platform === 'linux')
    return bwrapAvailability(await run('bwrap', ['--ro-bind', '/', '/', 'true']));
  if (platform === 'win32') {
    return unavailable(
      'Windows has no sandbox kindgi dev can use',
      'Run kindgi dev under WSL, where it uses the Linux one.',
    );
  }
  return unavailable(`kindgi dev has no sandbox for ${platform}`, `See ${DEV_SANDBOX_DOCS}.`);
}

function unavailable(reason: string, fix: string): SandboxAvailability {
  return { kind: 'unavailable', reason, fix };
}

/** What an empty `sandbox-exec` profile run says. */
function seatbeltAvailability(probe: ProbeResult): SandboxAvailability {
  if (probe.code === 0) return { kind: 'available', engine: 'seatbelt' };
  if (probe.errorCode === 'ENOENT') {
    return unavailable(`${SANDBOX_EXEC} isn't on this Mac`, `See ${DEV_SANDBOX_DOCS}.`);
  }
  if (/sandbox_apply/i.test(probe.stderr)) {
    return unavailable(
      'kindgi dev is already inside a sandbox (a coding agent’s?) that won’t let it add its own',
      'Run kindgi dev in your own terminal.',
    );
  }
  return unavailable(`sandbox-exec failed: ${firstLine(probe.stderr)}`, `See ${DEV_SANDBOX_DOCS}.`);
}

/** What an empty `bwrap` run says. */
function bwrapAvailability(probe: ProbeResult): SandboxAvailability {
  if (probe.code === 0) return { kind: 'available', engine: 'bwrap' };
  if (probe.errorCode === 'ENOENT') {
    return unavailable(
      "bubblewrap (bwrap) isn't installed",
      'Install bubblewrap (Debian, Ubuntu: sudo apt-get install bubblewrap; Fedora: sudo dnf install bubblewrap).',
    );
  }
  if (/uid map|setting up uid/i.test(probe.stderr)) {
    return unavailable(
      'this system blocks the user namespaces bwrap needs (Ubuntu 23.10 and later)',
      `Allow bwrap to use them: ${DEV_SANDBOX_DOCS}#where-it-runs.`,
    );
  }
  if (/new namespace|namespace failed|No permissions to create/i.test(probe.stderr)) {
    return unavailable(
      "this system doesn't allow user namespaces (a container, or a kernel setting)",
      `In a container, the container is the boundary; elsewhere see ${DEV_SANDBOX_DOCS}#where-it-runs.`,
    );
  }
  return unavailable(
    `bwrap failed: ${firstLine(probe.stderr)}`,
    `See ${DEV_SANDBOX_DOCS}#where-it-runs.`,
  );
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() || 'no message';
}
