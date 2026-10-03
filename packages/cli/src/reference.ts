// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The CLI described as data: every command with its usage, its flags and
 * its subcommands, and the global flags. No handlers. The CLI reference
 * on docs.kindgi.com is generated from it, so it can't drift from the
 * commands.
 */

import { ROOT_COMMANDS } from './commands/index.js';
import type { Command, ParseArgsOption } from './commands/types.js';
import { wiredCommands } from './commands/unwired.js';
import { GLOBAL_OPTION_SPEC } from './parse.js';

/** One flag: `--name` (and `-short`), taking a string or a boolean. */
export interface FlagReference {
  readonly name: string;
  readonly type: 'string' | 'boolean';
  readonly short?: string;
  /** The flag may be repeated. */
  readonly multiple?: boolean;
  readonly default?: string | boolean;
}

/** One command; a group of commands has subcommands and no usage. */
export interface CommandReference {
  readonly name: string;
  /** The words after `kindgi`, e.g. `['secrets', 'set']`. */
  readonly path: readonly string[];
  readonly description: string;
  /** The usage line (leaf commands only). */
  readonly usage?: string;
  /** The command's own flags, by name (leaf commands only). */
  readonly flags: readonly FlagReference[];
  readonly subcommands: readonly CommandReference[];
}

/** Every top-level command, in the order `kindgi --help` lists them. */
export function describeCommands(): readonly CommandReference[] {
  return wiredCommands(ROOT_COMMANDS).map((command) => describe(command, []));
}

/** The flags every command takes (`--url`, `--token`, `--json`, …), by name. */
export function describeGlobalFlags(): readonly FlagReference[] {
  return flags(GLOBAL_OPTION_SPEC);
}

function describe(command: Command, parent: readonly string[]): CommandReference {
  const path = [...parent, command.name];
  if (command.kind === 'group') {
    return {
      name: command.name,
      path,
      description: command.description,
      flags: [],
      subcommands: wiredCommands(command.subcommands, path).map((sub) => describe(sub, path)),
    };
  }
  return {
    name: command.name,
    path,
    description: command.description,
    usage: command.usage,
    flags: flags(command.optionSpec ?? {}),
    subcommands: [],
  };
}

function flags(spec: Readonly<Record<string, ParseArgsOption>>): readonly FlagReference[] {
  return Object.entries(spec)
    .map(([name, option]) => ({
      name,
      type: option.type,
      ...(option.short !== undefined && { short: option.short }),
      ...(option.multiple !== undefined && { multiple: option.multiple }),
      ...(option.default !== undefined && { default: option.default }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
