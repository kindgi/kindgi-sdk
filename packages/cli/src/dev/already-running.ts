// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What a second `kindgi dev` in a pack says, and exits with: where the
 * running one is, and how to restart it. Exit code 3 always means this,
 * so a script or a coding agent can tell "already running" from "failed"
 * before reading a word.
 */

import type { CommandResult } from '../commands/types.js';
import { type OutputFormat, renderJson } from '../output.js';
import type { DevLockRecord } from './dev-lock.js';

/** `kindgi dev` is already running for this pack. */
export const ALREADY_RUNNING_EXIT_CODE = 3;

/** Whether the running one's runtime answers: `undefined` when it hasn't said where it serves yet. */
export async function runtimeAnswers(
  holder: DevLockRecord,
  fetchFn: typeof fetch,
): Promise<boolean | undefined> {
  if (holder.apiUrl === undefined) return undefined;
  try {
    const res = await fetchFn(`${holder.apiUrl}/ready`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

function stopCommand(pid: number): string {
  return process.platform === 'win32' ? `taskkill /PID ${pid}` : `kill ${pid}`;
}

function since(takenAt: string): string {
  const at = new Date(takenAt);
  return Number.isNaN(at.getTime())
    ? takenAt
    : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The refusal's words. */
export function alreadyRunningText(holder: DevLockRecord, answering: boolean | undefined): string {
  const who = `pid ${holder.pid}, since ${since(holder.takenAt)}`;
  const stop = stopCommand(holder.pid);
  if (answering === false) {
    return [
      `kindgi dev: kindgi dev is already running for this pack (${who}), but its runtime isn't answering at ${holder.apiUrl}.`,
      `Stop it (Ctrl+C in its terminal, or \`${stop}\`), then run kindgi dev again.`,
      '',
    ].join('\n');
  }
  const where =
    answering === true
      ? [
          ...(holder.consoleUrl !== undefined ? [`  Console  ${holder.consoleUrl}`] : []),
          `  API      ${holder.apiUrl}   (.kindgirc.json points here)`,
        ]
      : ['  It is still starting.'];
  return [
    `kindgi dev: kindgi dev is already running for this pack (${who}).`,
    ...where,
    "It reloads the pack when its files change, so you don't need a second one.",
    `To restart it: stop that one first (Ctrl+C in its terminal, or \`${stop}\`), then run kindgi dev again.`,
    '',
  ].join('\n');
}

/** The refusal: its words on stderr, the facts on stdout when a format was asked for, exit 3. */
export async function alreadyRunning(
  holder: DevLockRecord,
  options: {
    readonly fetch: typeof fetch;
    readonly format: OutputFormat;
    readonly formatRequested: boolean;
  },
): Promise<CommandResult> {
  const answering = await runtimeAnswers(holder, options.fetch);
  const stdout = options.formatRequested
    ? renderJson(
        {
          running: {
            pid: holder.pid,
            since: holder.takenAt,
            ...(holder.apiUrl !== undefined && { apiUrl: holder.apiUrl }),
            ...(holder.consoleUrl !== undefined && { consoleUrl: holder.consoleUrl }),
            answering: answering ?? null,
          },
        },
        options.format,
      ).stdout
    : '';
  return {
    kind: 'ok',
    rendered: { stdout, stderr: alreadyRunningText(holder, answering) },
    exitCode: ALREADY_RUNNING_EXIT_CODE,
  };
}
