// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { ROOT_COMMANDS } from './commands/index.js';
import type { Command, ParseArgsOption } from './commands/types.js';
import { wiredCommands } from './commands/unwired.js';
import { GLOBAL_OPTION_SPEC } from './parse.js';

export function rootHelpText(): string {
  const lines: string[] = [];
  lines.push('kindgi — command-line interface for Kindgi™');
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

/**
 * What `kindgi <group> <word>` prints when `word` names none of the group's
 * subcommands: the mistake, the nearest subcommand when one is close, and
 * the group's help.
 */
export function unknownSubcommandText(
  group: Extract<Command, { kind: 'group' }>,
  path: readonly string[],
  word: string,
): string {
  const names = wiredCommands(group.subcommands, path).map((c) => c.name);
  const near = nearestSubcommand(word, names);
  const hint = near !== undefined ? ` Did you mean "${near}"?` : '';
  return `Unknown subcommand "${word}" for kindgi ${path.join(' ')}.${hint}\n\n${commandHelpText(group, path)}`;
}

/**
 * Top-level words that name a real command spelled another way: `improve`
 * is `proposals improve`; `eval` is the `test-runs` and `test-sets`
 * commands. Unlike a mistyped subcommand, these are nowhere near their real
 * names, so they are listed, not guessed by edit distance.
 */
const NEAR_MISS_COMMAND: Readonly<Record<string, readonly string[]>> = {
  improve: ['proposals improve'],
  eval: ['test-runs', 'test-sets'],
};

/** `"kindgi a"`, or `"kindgi a" or "kindgi b"`, or `"kindgi a", "kindgi b" or "kindgi c"`. */
function orQuoted(paths: readonly string[]): string {
  const quoted = paths.map((p) => `"kindgi ${p}"`);
  if (quoted.length <= 1) return quoted.join('');
  const last = quoted.at(-1) ?? '';
  return `${quoted.slice(0, -1).join(', ')} or ${last}`;
}

/**
 * What `kindgi <word> …` prints when `word` names no command: the mistake,
 * a pointer to the real command when the word is a known near-miss
 * (`improve` → `kindgi proposals improve`), and the root help.
 */
export function unknownCommandText(tokens: readonly string[]): string {
  const first = tokens[0];
  // Object.hasOwn: a word like "constructor" must read the map, never a prototype member.
  const targets =
    first !== undefined && Object.hasOwn(NEAR_MISS_COMMAND, first)
      ? NEAR_MISS_COMMAND[first]
      : undefined;
  const hint =
    targets !== undefined && targets.length > 0 ? ` Did you mean ${orQuoted(targets)}?` : '';
  return `Unknown command "${first ?? ''}".${hint}\n\n${rootHelpText()}`;
}

/** Words that mean a subcommand another group spells differently (`register` for `publish`). */
const SAME_MEANING: Readonly<Record<string, readonly string[]>> = {
  register: ['publish', 'set', 'create', 'add'],
  publish: ['register'],
  create: ['register', 'add', 'set'],
  add: ['register', 'create', 'set'],
  delete: ['unregister', 'remove', 'revoke'],
  remove: ['unregister', 'revoke', 'delete'],
  rm: ['unregister', 'remove', 'delete'],
  ls: ['list'],
  show: ['get'],
  describe: ['get'],
};

/**
 * A subcommand `word` was likely meant as: one another group spells this
 * way (`register` for `publish`), else one a typo away. Never the opposite
 * of what was typed (`unregister` for `register`).
 */
export function nearestSubcommand(word: string, names: readonly string[]): string | undefined {
  // Object.hasOwn: a word like "constructor" must read the map, never a prototype member.
  const synonyms = Object.hasOwn(SAME_MEANING, word) ? SAME_MEANING[word] : undefined;
  const synonym = synonyms?.find((alternative) => names.includes(alternative));
  if (synonym !== undefined) return synonym;
  return names
    .filter((name) => name !== `un${word}` && word !== `un${name}`)
    .map((name) => ({ name, distance: typoDistance(word, name) }))
    .filter(({ name, distance }) => distance <= (Math.min(word.length, name.length) <= 4 ? 1 : 2))
    .sort((a, b) => a.distance - b.distance)[0]?.name;
}

/** Edit distance where swapping two neighbouring letters is one edit (`lsit` → `list`). */
function typoDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = d[i] as number[];
      const above = d[i - 1] as number[];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(
        (above[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (above[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j] as number, ((d[i - 2] as number[])[j - 2] as number) + 1);
      }
    }
  }
  return (d[a.length] as number[])[b.length] as number;
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
