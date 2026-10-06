// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi observations list` (T238), through the client's `observations.query`. */

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

const OBSERVATION = {
  id: 'obs-1',
  supervisorId: 'sup-1',
  agentId: 'acme.helper',
  agentVersion: '1.0.0',
  conversationId: 'c-1',
  turnNumber: 1,
  status: 'succeeded',
  violations: [],
  durationMs: 42,
  costUsd: '0',
  observedAt: '2026-10-06T12:00:00Z',
};

async function list(flags: readonly string[]) {
  const calls: unknown[] = [];
  const out = await runCli({
    argv: ['observations', 'list', ...flags, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({
        observations: {
          query: async (filter: unknown) => {
            calls.push(filter);
            return { items: [OBSERVATION] };
          },
        },
      }) as never,
  });
  return { out, calls };
}

describe('kindgi observations list (T238)', () => {
  test('no filter', async () => {
    const { out, calls } = await list([]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([{}]);
    expect(out.stdout).toContain('obs-1');
  });

  test('every filter maps to the query', async () => {
    const { out, calls } = await list([
      '--status=tool-error',
      '--agent=acme.helper',
      '--agent-version=1.0.0',
      '--supervisor=sup-1',
      '--conversation=c-1',
      '--since=2026-10-01T00:00:00Z',
      '--until=2026-10-06T23:59:59Z',
      '--limit=10',
      '--cursor=2026-10-05T00:00:00Z',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      {
        status: 'tool-error',
        agentId: 'acme.helper',
        agentVersion: '1.0.0',
        supervisorId: 'sup-1',
        conversationId: 'c-1',
        since: '2026-10-01T00:00:00Z',
        until: '2026-10-06T23:59:59Z',
        limit: 10,
        cursor: '2026-10-05T00:00:00Z',
      },
    ]);
  });

  test('--agent-version needs --agent', async () => {
    const { out, calls } = await list(['--agent-version=1.0.0']);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain('--agent-version goes with --agent=<agent-id>');
    expect(calls).toEqual([]);
  });

  test('--table: when, which agent version, the turn, its status and time', async () => {
    const { out } = await list(['--table']);
    expect(out.stdout).toContain('acme.helper@1.0.0');
    expect(out.stdout).toContain('succeeded');
  });
});
