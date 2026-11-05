// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Commands that still work, and say which one to use instead until the
 * release that removes them: one line on stderr on every run. Stdout and
 * `--json` stay as they were, so a script reads the same answer. A
 * deprecated group's help line says it too (its `description`).
 *
 * A path is the command words (`'artifacts list'`), mapped to the command
 * that takes its place and the release that removes it. Removing a command
 * means removing it here (a test checks each entry names a command, and
 * one that replaces it).
 */
export const DEPRECATED_COMMANDS: ReadonlyMap<
  string,
  { readonly use: string; readonly removedIn: string }
> = new Map([
  ['artifacts list', { use: 'files list', removedIn: '0.8.0' }],
  ['artifacts get', { use: 'files get', removedIn: '0.8.0' }],
  ['artifacts upload', { use: 'files upload', removedIn: '0.8.0' }],
  ['artifacts download', { use: 'files download', removedIn: '0.8.0' }],
  // `kindgi files delete` asks first: a script that swaps the words keeps working with --yes.
  ['artifacts delete', { use: 'files delete --yes', removedIn: '0.8.0' }],
]);

/** The line a run of the command at `path` (its words) says on stderr: empty unless it's deprecated. */
export function deprecationNotice(path: readonly string[]): string {
  const words = path.join(' ');
  const entry = DEPRECATED_COMMANDS.get(words);
  return entry === undefined
    ? ''
    : `kindgi ${words} is deprecated: use kindgi ${entry.use}. Removed in ${entry.removedIn}.\n`;
}
