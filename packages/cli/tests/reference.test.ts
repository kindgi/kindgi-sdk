// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { type CommandReference, describeCommands, describeGlobalFlags } from '../src/index.js';

function find(commands: readonly CommandReference[], path: readonly string[]) {
  let level = commands;
  let found: CommandReference | undefined;
  for (const name of path) {
    found = level.find((c) => c.name === name);
    if (found === undefined) return undefined;
    level = found.subcommands;
  }
  return found;
}

function* walk(commands: readonly CommandReference[]): Generator<CommandReference> {
  for (const command of commands) {
    yield command;
    yield* walk(command.subcommands);
  }
}

describe('describeCommands', () => {
  test('a leaf carries its usage and its flags; a group, its subcommands', () => {
    const commands = describeCommands();
    const secrets = find(commands, ['secrets']);
    expect(secrets?.subcommands.length).toBeGreaterThan(0);
    expect(secrets?.usage).toBeUndefined();

    const set = find(commands, ['secrets', 'set']);
    expect(set?.path).toEqual(['secrets', 'set']);
    expect(set?.usage).toMatch(/^kindgi secrets set /);
    expect(set?.flags).toContainEqual(
      expect.objectContaining({ name: 'from-stdin', type: 'boolean' }),
    );
    const names = set?.flags.map((f) => f.name) ?? [];
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  test('every command is described, as plain data', () => {
    const all = [...walk(describeCommands())];
    expect(all.length).toBeGreaterThan(30);
    for (const command of all) {
      expect(command.name).not.toBe('');
      expect(command.description).not.toBe('');
      expect(command.path.at(-1)).toBe(command.name);
      expect(command.usage === undefined).toBe(command.subcommands.length > 0);
    }
    // No handlers: the whole tree survives a JSON round trip unchanged.
    expect(JSON.parse(JSON.stringify(describeCommands()))).toEqual(describeCommands());
  });
});

describe('describeGlobalFlags', () => {
  test('the flags every command takes', () => {
    const flags = describeGlobalFlags();
    expect(flags).toContainEqual(expect.objectContaining({ name: 'json', type: 'boolean' }));
    expect(flags).toContainEqual(
      expect.objectContaining({ name: 'verbose', type: 'boolean', short: 'v' }),
    );
    expect(flags).toContainEqual(expect.objectContaining({ name: 'url', type: 'string' }));
  });
});

describe('flag descriptions', () => {
  // `--help` and the CLI reference on the docs site both show them, so a
  // flag without one is a gap in both.
  test('every flag of every command, and every global flag, says what it does', () => {
    const missing: string[] = [];
    for (const command of walk(describeCommands())) {
      for (const flag of command.flags) {
        if (!flag.description?.trim())
          missing.push(`kindgi ${command.path.join(' ')} --${flag.name}`);
      }
    }
    for (const flag of describeGlobalFlags()) {
      if (!flag.description?.trim()) missing.push(`(global) --${flag.name}`);
    }
    expect(missing).toEqual([]);
  });
});
