// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A command's own option can't share a global flag's name: the global
 * wins when flags are parsed, so the command's option would never work
 * (T201, T206). The version-taking commands take the version as an
 * argument.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ROOT_COMMANDS } from '../src/commands/index.js';
import type { Command } from '../src/commands/types.js';
import { runCli } from '../src/main.js';
import { GLOBAL_OPTION_SPEC } from '../src/parse.js';

let home: string;
let cwd: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-cwd-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

/** Every leaf command, by the words that run it. */
function leaves(
  commands: readonly Command[],
  path: readonly string[] = [],
): { path: string; command: Command }[] {
  return commands.flatMap((command) =>
    command.kind === 'group'
      ? leaves(command.subcommands, [...path, command.name])
      : [{ path: [...path, command.name].join(' '), command }],
  );
}

describe('command options and the global flags', () => {
  test('no command option shares a name or a short flag with a global one', () => {
    const globalNames = new Set(Object.keys(GLOBAL_OPTION_SPEC));
    const globalShorts = new Set<string>(
      Object.values(GLOBAL_OPTION_SPEC).flatMap((o) => ('short' in o ? [o.short] : [])),
    );
    const shadows = leaves(ROOT_COMMANDS).flatMap(({ path, command }) =>
      command.kind !== 'leaf'
        ? []
        : Object.entries(command.optionSpec ?? {}).flatMap(([name, spec]) => [
            ...(globalNames.has(name) ? [`kindgi ${path} --${name}`] : []),
            ...(spec.short !== undefined && globalShorts.has(spec.short)
              ? [`kindgi ${path} -${spec.short}`]
              : []),
          ]),
    );
    expect(shadows).toEqual([]);
  });
});

describe('the version-taking tool commands take the version as an argument', () => {
  async function run(argv: readonly string[]) {
    const calls: unknown[][] = [];
    const rec =
      (name: string) =>
      async (...args: unknown[]) => {
        calls.push([name, ...args]);
        return { ok: true };
      };
    const out = await runCli({
      argv: [...argv, '--url=https://x', '--token=t'],
      env: {},
      cwd,
      home,
      clientFactory: () =>
        ({
          tools: {
            getVersion: rec('getVersion'),
            unregisterVersion: rec('unregisterVersion'),
            reinstateVersion: rec('reinstateVersion'),
          },
        }) as never,
    });
    return { out, calls };
  }

  test.each([
    ['get-version', 'getVersion'],
    ['unregister', 'unregisterVersion'],
    ['reinstate', 'reinstateVersion'],
  ])('kindgi tools %s <tool-id> <version>', async (sub, method) => {
    const { out, calls } = await run(['tools', sub, 'acme.echo', '1.2.0']);
    expect(out.exitCode).toBe(0);
    expect(calls).toEqual([[method, 'acme.echo', '1.2.0']]);
  });

  test('without the version: a usage error naming it', async () => {
    const { out, calls } = await run(['tools', 'get-version', 'acme.echo']);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain('version');
    expect(calls).toEqual([]);
  });
});
