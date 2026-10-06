// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { followEvalRun } from '../src/commands/eval-runs.js';
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

/** Start `acme.matches` with `extra` flags against a recording client. */
async function start(extra: readonly string[]) {
  const { calls, rec } = recorder();
  const out = await run(['eval-runs', 'start', 'acme.matches', '--project=p-1', ...extra], {
    evalRuns: { start: rec('start', { runId: 'er-1' }) },
  });
  return { out, calls };
}

describe('kindgi eval-runs start', () => {
  test('an agent with every comparison flag maps to one start call', async () => {
    const { out, calls } = await start([
      '--agent=acme.triage',
      '--agent-version=2.0.0',
      '--baseline=live',
      '--baseline-project=p-2',
      '--baseline-segment=region=eu',
      '--baseline-segment=tier=gold',
      '--reads=live',
      '--repetitions=3',
      '--k=5',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ runId: 'er-1' });
    expect(calls).toEqual([
      [
        'start',
        'acme.matches',
        {
          agentRef: { agentId: 'acme.triage', version: '2.0.0' },
          baseline: { live: { projectId: 'p-2', segments: { region: 'eu', tier: 'gold' } } },
          reads: 'live',
          repetitions: 3,
          k: 5,
        },
        { projectId: 'p-1' },
      ],
    ]);
  });

  test('a flow with a version, and only the fields given', async () => {
    const { out, calls } = await start(['--flow=acme.intake', '--flow-version=1.0.0']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'start',
        'acme.matches',
        { flowRef: { flowId: 'acme.intake', version: '1.0.0' } },
        { projectId: 'p-1' },
      ],
    ]);
  });

  test('--baseline=recorded', async () => {
    const { calls } = await start(['--agent=a', '--baseline=recorded']);
    expect(calls[0]?.[2]).toEqual({ agentRef: { agentId: 'a' }, baseline: 'recorded' });
  });

  test('--baseline=<agentId>@<version> splits on the last @', async () => {
    const { calls } = await start(['--agent=a', '--baseline=acme.triage@1.4.0']);
    expect(calls[0]?.[2]).toEqual({
      agentRef: { agentId: 'a' },
      baseline: { agentId: 'acme.triage', version: '1.4.0' },
    });
    const odd = await start(['--agent=a', '--baseline=acme@team.triage@1.4.0']);
    expect(odd.calls[0]?.[2]).toMatchObject({
      baseline: { agentId: 'acme@team.triage', version: '1.4.0' },
    });
  });

  test('--baseline=live alone sends an empty live baseline', async () => {
    const { calls } = await start(['--agent=a', '--baseline=live']);
    expect(calls[0]?.[2]).toEqual({ agentRef: { agentId: 'a' }, baseline: { live: {} } });
  });

  test('--dry-run passes dryRun: true', async () => {
    const { calls } = await start(['--agent=a', '--dry-run']);
    expect(calls[0]?.[2]).toEqual({ agentRef: { agentId: 'a' }, dryRun: true });
  });

  test('errors: no project', async () => {
    const out = await run(['eval-runs', 'start', 'acme.matches', '--agent=a'], { evalRuns: {} });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('--project=<id> is required');
  });

  test('errors: both or neither of agent and flow', async () => {
    for (const extra of [['--agent=a', '--flow=f'], []]) {
      const { out, calls } = await start(extra);
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain('Give exactly one of --agent=<id> or --flow=<id>');
      expect(calls).toEqual([]);
    }
  });

  test('errors: a version without its agent or flow', async () => {
    const out = await start(['--flow=f', '--agent-version=1.0.0']);
    expect(out.out.stderr).toContain('--agent-version needs --agent');
  });

  test('errors: a bad --reads', async () => {
    const { out } = await start(['--agent=a', '--reads=maybe']);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('--reads must be one of recorded, live');
  });

  test('errors: --baseline-segment or --baseline-project without --baseline=live', async () => {
    for (const extra of [
      ['--baseline-segment=region=eu'],
      ['--baseline=recorded', '--baseline-segment=region=eu'],
      ['--baseline-project=p-2'],
    ]) {
      const { out, calls } = await start(['--agent=a', ...extra]);
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain('need --baseline=live');
      expect(calls).toEqual([]);
    }
  });

  test('errors: a malformed segment', async () => {
    for (const bad of ['region', 'region=', '=eu']) {
      const { out } = await start(['--agent=a', '--baseline=live', `--baseline-segment=${bad}`]);
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain('--baseline-segment must be <key>=<value>');
    }
  });

  test('errors: a malformed --baseline', async () => {
    for (const bad of ['acme.triage', 'acme.triage@', '@1.0.0']) {
      const { out } = await start(['--agent=a', `--baseline=${bad}`]);
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain('--baseline must be recorded, live or <agentId>@<version>');
    }
  });
});

describe('kindgi eval-runs start --wait', () => {
  test('reads the run after starting it, and prints it once it is done', async () => {
    // One real pause (1 s) before the first read; followEvalRun's own tests
    // cover the polling with no real time passing.
    const { calls, rec } = recorder();
    const out = await run(
      ['eval-runs', 'start', 'acme.matches', '--project=p-1', '--agent=a', '--wait'],
      {
        evalRuns: {
          start: rec('start', { runId: 'er-1' }),
          get: async (id: string) => {
            calls.push(['get', id]);
            return { id, status: 'completed' };
          },
        },
      },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ id: 'er-1', status: 'completed' });
    expect(calls.map((c) => c[0])).toEqual(['start', 'get']);
  });
});

describe('followEvalRun', () => {
  test('reads after each pause until the run leaves pending and running', async () => {
    const slept: number[] = [];
    const statuses = ['pending', 'running', 'failed'];
    const run = await followEvalRun('er-1', {
      get: async () => ({ status: statuses.shift() ?? 'failed' }),
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(run).toEqual({ status: 'failed' });
    expect(slept).toEqual([1_000, 1_000, 1_000]);
  });

  test('gives up after the longest wait, naming the command that shows the run', async () => {
    await expect(
      followEvalRun('er-1', {
        get: async () => ({ status: 'running' }),
        sleep: async () => {},
        maxMs: 30 * 60 * 1_000,
      }),
    ).rejects.toThrow('Still running after 30 minutes: kindgi eval-runs show er-1');
  });
});

describe('kindgi eval-runs show / list / cancel', () => {
  test('show gets the run', async () => {
    const { calls, rec } = recorder();
    const out = await run(['eval-runs', 'show', 'er-1'], { evalRuns: { get: rec('get') } });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['get', 'er-1']]);
  });

  test('list narrows by suite, status and agent', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'eval-runs',
        'list',
        '--suite=acme.matches',
        '--status=completed',
        '--agent=acme.triage',
        '--limit=5',
        '--cursor=c1',
      ],
      { evalRuns: { list: rec('list', { data: [], hasMore: false }) } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'list',
        {
          suiteId: 'acme.matches',
          status: 'completed',
          agentId: 'acme.triage',
          limit: 5,
          cursor: 'c1',
        },
      ],
    ]);
  });

  test('list rejects an unknown status', async () => {
    const out = await run(['eval-runs', 'list', '--status=bogus'], { evalRuns: {} });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('--status must be one of');
  });

  test('cancel cancels the run', async () => {
    const { calls, rec } = recorder();
    const out = await run(['eval-runs', 'cancel', 'er-1'], { evalRuns: { cancel: rec('cancel') } });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['cancel', 'er-1']]);
  });
});
