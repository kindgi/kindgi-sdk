// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { ROOT_COMMANDS } from './commands/index.js';
import type { Command } from './commands/types.js';
import { wiredCommands } from './commands/unwired.js';

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
  lines.push('  --url=<url>          Override KINDGI_API_URL.');
  lines.push('  --token=<token>      Override KINDGI_API_TOKEN.');
  lines.push('  --json               Pretty JSON output (default).');
  lines.push('  --raw                Tight one-line JSON.');
  lines.push('  --table              Table output for list responses.');
  lines.push('  --quiet              Suppress stdout; exit code only.');
  lines.push('  --verbose, -v        Verbose error output.');
  lines.push('  --version            Print CLI version.');
  lines.push('  --help, -h           Show help.');
  lines.push('');
  lines.push('Config precedence: --flag > env var > ~/.kindgi/config.json.');
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
  } else {
    lines.push(`Usage: kindgi ${command.name} <subcommand> [args] [flags]`);
    lines.push('');
    lines.push('Subcommands:');
    for (const sub of wiredCommands(command.subcommands, path)) {
      lines.push(`  ${sub.name.padEnd(16, ' ')}  ${sub.description}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
