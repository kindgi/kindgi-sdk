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
    expect(root).not.toMatch(/^ {2}memory /m);
    expect(root).not.toMatch(/^ {2}artifacts /m);

    const runs = ROOT_COMMANDS.find((c) => c.name === 'runs')!;
    const help = commandHelpText(runs, ['runs']);
    expect(help).toContain('start');
    expect(help).not.toMatch(/^ {2}resume /m);

    const reference = describeCommands();
    expect(reference.map((c) => c.name)).not.toContain('memory');
    const runsRef = reference.find((c) => c.name === 'runs')!;
    expect(runsRef.subcommands.map((s) => s.name)).toContain('start');
    expect(runsRef.subcommands.map((s) => s.name)).not.toContain('resume');
  });
});
