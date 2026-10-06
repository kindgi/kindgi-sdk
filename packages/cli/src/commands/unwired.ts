// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Command } from './types.js';

/**
 * Commands whose API this release doesn't wire yet: they call
 * `throwUnwired` and fail with "not yet wired". They stay callable, so a
 * script gets an honest error rather than "unknown command", but `--help`
 * and the generated reference leave them out until they work.
 *
 * A path is the command words (`'agents list'`); a group's path hides the
 * whole group. Wiring a command means removing it here (a test counts the
 * `throwUnwired` call sites against this list).
 */
export const UNWIRED_COMMANDS: ReadonlySet<string> = new Set([
  'artifacts',
  'capabilities',
  'conversations get',
  'conversations open',
  'conversations close',
  'conversations messages',
  'flows',
  'memory',
  'observations',
  'proposals',
  'provenance',
  'tokens',
  'agents list',
  'agents get',
  'agents unregister',
  'agents versions',
  'tools publish',
  'runs resume',
]);

/**
 * Why a listed command isn't available, when the reason isn't simply "not
 * wired yet": what the CLI prints instead of the generic message.
 */
export const UNWIRED_REASONS: ReadonlyMap<string, string> = new Map([
  [
    'runs resume',
    'resuming a run at a waitpoint is not available in this release: every waitpoint belongs to an approval or to the runtime. A run waiting for an approval continues when a reviewer decides it: `kindgi approvals complete <approval-id> --decision=approve`.',
  ],
]);

/** Whether the command at `path` (its words, from the root) is wired. */
export function isWired(path: readonly string[]): boolean {
  for (let i = 1; i <= path.length; i += 1) {
    if (UNWIRED_COMMANDS.has(path.slice(0, i).join(' '))) return false;
  }
  return true;
}

/** The commands under `parent` (its words) that are wired, in order. */
export function wiredCommands(
  commands: readonly Command[],
  parent: readonly string[] = [],
): readonly Command[] {
  return commands.filter((command) => isWired([...parent, command.name]));
}
