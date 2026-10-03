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

/** Run the CLI against a stub client that records each call. */
async function run(argv: readonly string[], client: Record<string, unknown>) {
  return runCli({
    argv: [...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () => client as never,
  });
}

function recorder() {
  const calls: [string, ...unknown[]][] = [];
  const rec =
    (name: string, result: unknown = { ok: true }) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result;
    };
  return { calls, rec };
}

describe('kindgi approvals', () => {
  test('list passes --status, --limit and --cursor', async () => {
    const { calls, rec } = recorder();
    const out = await run(['approvals', 'list', '--status=pending', '--limit=5', '--cursor=c1'], {
      approvals: { list: rec('list', { data: [{ id: 'a-1' }] }) },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['list', { status: 'pending', limit: 5, cursor: 'c1' }]]);
    expect(JSON.parse(out.stdout)).toEqual({ data: [{ id: 'a-1' }] });
  });

  test('list refuses an unknown status', async () => {
    const out = await run(['approvals', 'list', '--status=open'], { approvals: {} });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('--status must be one of pending');
  });

  test('get fetches the approval', async () => {
    const { calls, rec } = recorder();
    await run(['approvals', 'get', 'a-1'], { approvals: { get: rec('get', { id: 'a-1' }) } });
    expect(calls).toEqual([['get', 'a-1']]);
  });

  test('complete records the decision, with its rationale', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      ['approvals', 'complete', 'a-1', '--decision=approve', '--rationale=looks right'],
      {
        approvals: { decide: rec('decide', { kind: 'decided' }) },
      },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['decide', 'a-1', { decision: 'approve', rationale: 'looks right' }]]);
  });

  test('complete needs a known --decision', async () => {
    const missing = await run(['approvals', 'complete', 'a-1'], { approvals: {} });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('--decision=approve|reject|escalate|withdraw is required');
    const wrong = await run(['approvals', 'complete', 'a-1', '--decision=yes'], { approvals: {} });
    expect(wrong.exitCode).toBe(1);
    expect(wrong.stderr).toContain('--decision must be one of approve');
  });
});

describe('kindgi reviewers', () => {
  test('register without a userId registers you', async () => {
    const { calls, rec } = recorder();
    const out = await run(['reviewers', 'register', '--spec={"role":"senior"}'], {
      identity: { whoami: rec('whoami', { userId: 'u-me', tenantId: 't-1' }) },
      approvals: { reviewers: { register: rec('register', { id: 'r-1', role: 'senior' }) } },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['whoami'], ['register', { userId: 'u-me', role: 'senior' }]]);
  });

  test('register with a userId uses it', async () => {
    const { calls, rec } = recorder();
    await run(
      ['reviewers', 'register', '--spec={"userId":"u-2","role":"admin","displayName":"Dana"}'],
      {
        approvals: { reviewers: { register: rec('register') } },
      },
    );
    expect(calls).toEqual([['register', { userId: 'u-2', role: 'admin', displayName: 'Dana' }]]);
  });

  test('register needs a role', async () => {
    const out = await run(['reviewers', 'register', '--spec={}'], { approvals: { reviewers: {} } });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('`role`');
  });

  test('list, get and unregister reach the roster', async () => {
    const { calls, rec } = recorder();
    const client = {
      approvals: {
        reviewers: {
          list: rec('list', { data: [] }),
          get: rec('get'),
          deactivate: rec('deactivate'),
        },
      },
    };
    await run(['reviewers', 'list', '--limit=10'], client);
    await run(['reviewers', 'get', 'r-1'], client);
    await run(['reviewers', 'unregister', 'r-1'], client);
    expect(calls).toEqual([
      ['list', { limit: 10 }],
      ['get', 'r-1'],
      ['deactivate', 'r-1'],
    ]);
  });
});
