// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { ROOT_COMMANDS, findCommand } from '../src/commands/index.js';
import type { Command } from '../src/commands/types.js';
import { UNWIRED_COMMANDS, isWired } from '../src/commands/unwired.js';
import { commandHelpText, rootHelpText } from '../src/help.js';
import { describeCommands } from '../src/reference.js';

function leaves(command: Command, path: readonly string[]): string[][] {
  const here = [...path, command.name];
  if (command.kind === 'leaf') return [here];
  return command.subcommands.flatMap((sub) => leaves(sub, here));
}

describe('commands the API does not wire yet', () => {
  test('every listed path is a real command', () => {
    for (const path of UNWIRED_COMMANDS) {
      const words = path.split(' ');
      const found = findCommand(words);
      expect(found?.consumed, path).toBe(words.length);
    }
  });

  test('the list matches the throwUnwired call sites, so wiring a command means un-listing it', () => {
    const dir = join(import.meta.dirname, '..', 'src', 'commands');
    const sites = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && f !== 'helpers.ts')
      .reduce(
        (n, f) => n + (readFileSync(join(dir, f), 'utf8').match(/throwUnwired\(/g) ?? []).length,
        0,
      );
    const hidden = ROOT_COMMANDS.flatMap((c) => leaves(c, [])).filter((p) => !isWired(p));
    expect(hidden.length).toBe(sites);
  });

  test('root help and the reference leave them out; a partly wired group lists only what works', () => {
    const root = rootHelpText();
    expect(root).toContain('  runs');
    expect(root).not.toMatch(/^ {2}observations /m);
    expect(root).not.toMatch(/^ {2}proposals /m);
    // Wired in 0.1.5 (T252): the runtime serves both.
    expect(root).toMatch(/^ {2}artifacts /m);
    expect(root).toMatch(/^ {2}capabilities /m);

    const memory = ROOT_COMMANDS.find((c) => c.name === 'memory')!;
    const facts = (memory.kind === 'group' ? memory.subcommands : []).find(
      (c) => c.name === 'facts',
    )!;
    const help = commandHelpText(facts, ['memory', 'facts']);
    expect(help).toContain('write');
    expect(help).not.toMatch(/^ {2}supersede /m);
    expect(help).not.toMatch(/^ {2}retrieve /m);

    const reference = describeCommands();
    expect(reference.map((c) => c.name)).not.toContain('observations');
    expect(reference.map((c) => c.name)).toContain('capabilities');
    const memoryRef = reference.find((c) => c.name === 'memory')!;
    const factsRef = memoryRef.subcommands.find((s) => s.name === 'facts')!;
    expect(factsRef.subcommands.map((s) => s.name)).toContain('write');
    expect(factsRef.subcommands.map((s) => s.name)).not.toContain('supersede');
    // `runs resume` is wired (T272): it says what a run waits for.
    const runsRef = reference.find((c) => c.name === 'runs')!;
    expect(runsRef.subcommands.map((s) => s.name)).toContain('resume');
  });
});
