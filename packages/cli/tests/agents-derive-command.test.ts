// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runCli } from '../src/main.js';

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

/** Run `kindgi agents derive` against a stub client that records each call. */
async function derive(args: readonly string[]) {
  const calls: unknown[][] = [];
  const out = await runCli({
    argv: ['agents', 'derive', ...args, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({
        agents: {
          versions: {
            derive: async (...a: unknown[]) => {
              calls.push(a);
              return { id: 'acme.intake', version: '1.4.1' };
            },
          },
        },
      }) as never,
  });
  return { out, calls };
}

describe('kindgi agents derive', () => {
  test('sends the source version, each repeated pin swap, and the label', async () => {
    const { out, calls } = await derive([
      'acme.intake',
      '--from=1.4.0',
      '--prompt=acme.intake-prompt=1.1.0',
      '--setting=acme.weights=1.2.0',
      '--setting=acme.model=1.0.1',
      '--label=Tighter tone',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'acme.intake',
        {
          from: '1.4.0',
          pins: {
            prompts: { 'acme.intake-prompt': '1.1.0' },
            settings: { 'acme.weights': '1.2.0', 'acme.model': '1.0.1' },
          },
          label: 'Tighter tone',
        },
      ],
    ]);
  });

  test('--project passes through; only the kinds given are sent', async () => {
    const { out, calls } = await derive([
      'acme.intake',
      '--from=1.4.0',
      '--setting=acme.weights=1.2.0',
      '--project=p-1',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls[0]?.[1]).toEqual({
      from: '1.4.0',
      pins: { settings: { 'acme.weights': '1.2.0' } },
      projectId: 'p-1',
    });
  });

  test('refuses a missing --from, no swaps, or a malformed swap', async () => {
    const noFrom = await derive(['acme.intake', '--prompt=acme.p=1.0.0']);
    expect(noFrom.out.exitCode).toBe(1);
    expect(noFrom.out.stderr).toContain('--from=<semver> is required');

    const none = await derive(['acme.intake', '--from=1.4.0']);
    expect(none.out.exitCode).toBe(1);
    expect(none.out.stderr).toContain('Name at least one pin to swap');

    const bad = await derive(['acme.intake', '--from=1.4.0', '--prompt=acme.p']);
    expect(bad.out.exitCode).toBe(1);
    expect(bad.out.stderr).toContain("--prompt takes <block-id>=<version>, got 'acme.p'");
    expect([noFrom, none, bad].flatMap((r) => r.calls)).toEqual([]);
  });
});
