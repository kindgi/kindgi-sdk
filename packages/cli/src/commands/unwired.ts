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
  'observations',
  'proposals',
  'tokens',
  'memory facts supersede',
  'memory facts retrieve',
]);

/** Why `kindgi tokens` is unwired: the runtime wires no `tokenAdmin`, so `/v1/tokens` isn't mounted (T243). */
const TOKENS_NOT_SERVED =
  "the Kindgi runtime doesn't serve `/v1/tokens` yet, so it has no API keys to mint or revoke; it authenticates with the token it starts with (`KINDGI_API_TOKEN`, or the one `kindgi dev` prints).";

/**
 * Why a command (or a whole group: a command's nearest listed path counts)
 * is unwired, when there's more to say than "not yet wired".
 */
export const UNWIRED_REASONS: ReadonlyMap<string, string> = new Map([
  ['tokens create', TOKENS_NOT_SERVED],
  ['tokens revoke', TOKENS_NOT_SERVED],
  [
    'memory facts supersede',
    "the Kindgi runtime doesn't supersede memory facts yet: it would answer that no such fact exists, even for one that does.",
  ],
  [
    'memory facts retrieve',
    "the Kindgi runtime doesn't search memory yet (keyword or semantic): a retrieval would find nothing. To list facts by type or scope: `kindgi memory facts list --type=<type> --scope=<json>`.",
  ],
  [
    'observations',
    "the Kindgi runtime doesn't record supervisor observations yet, so there's nothing to list; how a run went is in `kindgi runs get <run-id>` and `kindgi runs journal <run-id>`.",
  ],
  ['proposals', "the Kindgi runtime doesn't draft or apply supervisor fix proposals yet."],
]);

/** The reason a command at `path` (its words) is unwired, from its nearest listed path. */
export function unwiredReason(path: readonly string[]): string | undefined {
  for (let i = path.length; i >= 1; i -= 1) {
    const reason = UNWIRED_REASONS.get(path.slice(0, i).join(' '));
    if (reason !== undefined) return reason;
  }
  return undefined;
}

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
