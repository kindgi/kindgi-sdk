// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { ROOT_COMMANDS } from './commands/index.js';
import type { Command, ParseArgsOption } from './commands/types.js';
import { wiredCommands } from './commands/unwired.js';
import { GLOBAL_OPTION_SPEC } from './parse.js';

export function rootHelpText(): string {
  const lines: string[] = [];
  lines.push('kindgi — command-line interface for Kindgi™ — the sovereign AI OS');
  lines.push('');
  lines.push('Usage: kindgi <command> [<subcommand>] [args] [flags]');
  lines.push('');
  lines.push('Commands:');
  for (const c of wiredCommands(ROOT_COMMANDS)) {
    lines.push(`  ${c.name.padEnd(16, ' ')}  ${c.description}`);
  }
  lines.push('');
  lines.push('Global flags:');
  lines.push(...flagLines(GLOBAL_OPTION_SPEC));
  lines.push('');
  lines.push(
    'Config precedence: --flag > env var > .kindgirc.json (this directory) > ~/.kindgi/config.json.',
  );
  return `${lines.join('\n')}\n`;
}

/** `path`: the command's words from the root, so a group lists only its wired subcommands. */
export function commandHelpText(
  command: Command,
  path: readonly string[] = [command.name],
): string {
  const lines: string[] = [];
  lines.push(command.description);
  lines.push('');
  if (command.kind === 'leaf') {
    lines.push(`Usage: ${command.usage}`);
    const flags = flagLines(command.optionSpec ?? {});
    if (flags.length > 0) {
      lines.push('');
      lines.push('Flags:');
      lines.push(...flags);
    }
    lines.push('');
    lines.push('Global flags (--json, --url, --token, …): kindgi --help');
  } else {
    lines.push(`Usage: kindgi ${path.join(' ')} <subcommand> [args] [flags]`);
    lines.push('');
    lines.push('Subcommands:');
    for (const sub of wiredCommands(command.subcommands, path)) {
      lines.push(`  ${sub.name.padEnd(16, ' ')}  ${sub.description}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** `  --name <value>, -n   What it does.`, one line per flag, by name. */
function flagLines(spec: Readonly<Record<string, ParseArgsOption>>): string[] {
  const rows = Object.entries(spec)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, option]) => {
      const value =
        option.type === 'string' ? (option.optionalValue ? '[=<value>]' : ' <value>') : '';
      const short = option.short ? `, -${option.short}` : '';
      return [`--${name}${value}${short}`, option.description ?? ''] as const;
    });
  const width = Math.max(0, ...rows.map(([label]) => label.length));
  return rows.map(([label, description]) => `  ${label.padEnd(width)}  ${description}`.trimEnd());
}
