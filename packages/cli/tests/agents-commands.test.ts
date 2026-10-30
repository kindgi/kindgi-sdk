// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KindgiApiError, fromWire } from '@kindgi/client';
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

const PROJECT = '0b9f4c1e-1111-4a2b-8c3d-000000000001';
const ORG = '0b9f4c1e-2222-4a2b-8c3d-000000000002';

function pin(over: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    agentId: 'acme.drafter',
    scope: { kind: 'segment', projectId: PROJECT, path: [{ key: 'company', value: 'acme' }] },
    action: 'pin',
    fromVersion: null,
    toVersion: '1.1.0',
    requestedBy: { kind: 'user', id: 'u-1' },
    createdAt: '2026-10-05T12:00:00.000Z',
    ...over,
  };
}

describe('kindgi agents — the registry', () => {
  test('list, get (latest or a version), versions and unregister call the client', async () => {
    const { calls, rec } = recorder();
    const client = {
      agents: {
        list: rec('list', { data: [], hasMore: false }),
        get: rec('get'),
        versions: {
          get: rec('versions.get'),
          list: rec('versions.list', { data: [], hasMore: false }),
          unregister: rec('versions.unregister'),
        },
      },
    };
    for (const argv of [
      ['agents', 'list', '--name=acme', '--limit=5'],
      ['agents', 'get', 'acme.drafter'],
      ['agents', 'get', 'acme.drafter', '1.0.0'],
      ['agents', 'versions', 'acme.drafter', '--cursor=c-1'],
      ['agents', 'unregister', 'acme.drafter', '1.0.0'],
    ]) {
      const out = await run(argv, client);
      expect(out.exitCode, out.stderr).toBe(0);
    }
    expect(calls).toEqual([
      ['list', { limit: 5, name: 'acme' }],
      ['get', 'acme.drafter'],
      ['versions.get', 'acme.drafter', '1.0.0'],
      ['versions.list', 'acme.drafter', { cursor: 'c-1' }],
      ['versions.unregister', 'acme.drafter', '1.0.0'],
    ]);
  });

  test('unregister without a version fails before calling', async () => {
    const { calls, rec } = recorder();
    const out = await run(['agents', 'unregister', 'acme.drafter'], {
      agents: { versions: { unregister: rec('versions.unregister') } },
    });
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain('version');
    expect(calls).toEqual([]);
  });
});

describe('kindgi agents — pinned versions', () => {
  test('pinned resolves for a project and a segment path, in order', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'agents',
        'pinned',
        'acme.drafter',
        `--project=${PROJECT}`,
        '--segment=company:acme',
        '--segment=role:counsel',
      ],
      { agents: { pinned: { resolve: rec('resolve', { version: '1.1.0', via: 'pinned' }) } } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'resolve',
        'acme.drafter',
        {
          projectId: PROJECT,
          segments: [
            { key: 'company', value: 'acme' },
            { key: 'role', value: 'counsel' },
          ],
        },
      ],
    ]);
  });

  test('pin to a segment scope, with a reason and the test run', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'agents',
        'pin',
        'acme.drafter',
        '1.1.0',
        `--project=${PROJECT}`,
        '--segment=company:acme',
        '--reason=passed the gate',
        '--test-run=er-1',
        '--idempotency-key=k-1',
      ],
      { agents: { pinned: { pin: rec('pin', pin()) } } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'pin',
        'acme.drafter',
        {
          version: '1.1.0',
          scope: { kind: 'segment', projectId: PROJECT, path: [{ key: 'company', value: 'acme' }] },
          reason: 'passed the gate',
          testRunId: 'er-1',
        },
        { idempotencyKey: 'k-1' },
      ],
    ]);
  });

  test.each([
    [['1.1.0'], 'Name the scope'],
    [['1.1.0', '--tenant', `--org=${ORG}`], 'one of --tenant, --org or --project'],
    [['1.1.0', '--segment=company:acme'], '--segment needs --project'],
    [['1.1.0', `--project=${PROJECT}`, '--segment=company'], 'key:value'],
    [['--tenant'], 'version'],
  ])('pin %j fails before calling: %s', async (flags, message) => {
    const { calls, rec } = recorder();
    const out = await run(['agents', 'pin', 'acme.drafter', ...flags], {
      agents: { pinned: { pin: rec('pin') } },
    });
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain(message);
    expect(calls).toEqual([]);
  });

  test('unpin the tenant', async () => {
    const { calls, rec } = recorder();
    const client = { agents: { pinned: { unpin: rec('unpin', pin({ action: 'unpin' })) } } };
    const unpinned = await run(['agents', 'unpin', 'acme.drafter', '--tenant'], client);
    expect(unpinned.exitCode, unpinned.stderr).toBe(0);
    expect(calls).toEqual([['unpin', 'acme.drafter', { scope: { kind: 'tenant' } }, {}]]);
  });

  test('pinned-versions --table shows each scope and its version', async () => {
    const { rec } = recorder();
    const out = await run(['agents', 'pinned-versions', 'acme.drafter', '--table'], {
      agents: {
        pinned: {
          list: rec('list', {
            data: [
              {
                agentId: 'acme.drafter',
                scope: {
                  kind: 'segment',
                  projectId: PROJECT,
                  path: [{ key: 'company', value: 'acme' }],
                },
                version: '1.1.0',
                changeId: 'p-1',
                setAt: '2026-10-05T12:00:00.000Z',
              },
            ],
          }),
        },
      },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stdout).toContain('SCOPE');
    expect(out.stdout).toContain(`project ${PROJECT} company=acme`);
    expect(out.stdout).toContain('1.1.0');
  });

  test('pin-history list --table says where each row stands', async () => {
    const out = await run(['agents', 'pin-history', 'list', 'acme.drafter', '--table'], {
      agents: {
        pinned: {
          history: async () => ({
            data: [
              pin({ id: 'p-pending', toVersion: '1.4.0', status: 'pending-approval' }),
              pin({ id: 'p-refused', toVersion: '1.3.0', status: 'refused' }),
              pin({ id: 'p-pinned', toVersion: '1.2.0', status: 'pinned' }),
              pin({ id: 'p-before-gates', toVersion: '1.1.0' }),
              pin({ id: 'p-unpin', action: 'unpin', fromVersion: '1.1.0', toVersion: null }),
            ],
            hasMore: false,
          }),
        },
      },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    const lines = out.stdout.split('\n');
    expect(lines[0]).toMatch(/^ID\s+ACTION\s+STATUS\s+SCOPE/);
    const status = (id: string) => lines.find((l) => l.startsWith(id))?.split(/\s+/)[2];
    expect(status('p-pending')).toBe('pending-approval');
    expect(status('p-refused')).toBe('refused');
    expect(status('p-pinned')).toBe('pinned');
    expect(status('p-before-gates')).toBe('pinned');
    expect(status('p-unpin')).toBe('done');
  });

  test('pin-history list narrows to a scope; pin-history get fetches one', async () => {
    const { calls, rec } = recorder();
    const client = {
      agents: {
        pinned: {
          history: rec('history', { data: [pin()], hasMore: false }),
          getChange: rec('getChange', pin()),
        },
      },
    };
    const listed = await run(
      ['agents', 'pin-history', 'list', 'acme.drafter', `--project=${PROJECT}`, '--limit=10'],
      client,
    );
    expect(listed.exitCode, listed.stderr).toBe(0);
    const got = await run(['agents', 'pin-history', 'get', 'acme.drafter', 'p-1'], client);
    expect(got.exitCode, got.stderr).toBe(0);
    expect(calls).toEqual([
      ['history', 'acme.drafter', { limit: 10, scope: { kind: 'project', projectId: PROJECT } }],
      ['getChange', 'acme.drafter', 'p-1'],
    ]);
  });
});

describe('agents pin: exit 3 when the answer is no, and --wait for an approval', () => {
  const SCOPE = ['acme.drafter', '1.1.0', `--project=${PROJECT}`];
  const PENDING = pin({ status: 'pending-approval', approvalId: 'ap-1' });

  /**
   * `run`, with `--wait`'s clock and pauses: each pause moves the clock on,
   * so a wait takes no time. A rate limit's wait is recorded in `slept`.
   */
  async function runWaiting(
    argv: readonly string[],
    client: Record<string, unknown>,
    stopSignal?: AbortSignal,
  ) {
    const pauses: number[] = [];
    const slept: number[] = [];
    let clock = 0;
    const out = await runCli({
      argv: [...argv, '--url=https://x', '--token=t'],
      env: {},
      cwd,
      home,
      clientFactory: () => client as never,
      approvalWaitSeam: {
        now: () => clock,
        pause: async (ms: number) => {
          pauses.push(ms);
          clock += ms;
        },
      },
      rateLimitWaits: {
        sleep: async (ms: number) => {
          slept.push(ms);
        },
        now: () => 0,
        write: () => {},
      },
      ...(stopSignal !== undefined && { stopSignal }),
    });
    return { out, pauses, slept };
  }

  /** `get` answers each read with the next of `statuses`, then the last, recording each. */
  function reads(calls: unknown[][], ...statuses: string[]) {
    let i = 0;
    return async (...args: unknown[]) => {
      calls.push(['getChange', ...args]);
      const status = statuses[Math.min(i++, statuses.length - 1)];
      return pin({ status, approvalId: 'ap-1', resolvedAt: '2026-10-05T12:05:00.000Z' });
    };
  }

  /** `get` answers each read with the next of `answers`: a status, or an error it throws. */
  function readsOrFails(calls: unknown[][], ...answers: (string | Error)[]) {
    let i = 0;
    return async (...args: unknown[]) => {
      calls.push(['getChange', ...args]);
      const answer = answers[Math.min(i++, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return pin({ status: answer, approvalId: 'ap-1' });
    };
  }

  const unavailable = () =>
    new KindgiApiError(fromWire({ code: 'unavailable', message: 'Down for a moment' }, 503));

  test.each([
    ['would-pin', 0],
    ['needs-approval', 3],
    ['gate-failed', 3],
  ])('--check answering %s exits %i, the answer printed as it is', async (outcome, code) => {
    const answer = { outcome, releaseGate: null, checks: [] };
    const out = await run(['agents', 'pin', ...SCOPE, '--check'], {
      agents: { pinned: { check: async () => answer } },
    });
    expect(out.exitCode, out.stderr).toBe(code);
    expect(JSON.parse(out.stdout)).toEqual(answer);
  });

  test("the gate's refusal (422 gate-failed) is said as before, exit 3", async () => {
    const message =
      'The release gate refused acme.drafter 1.1.0: Precision at 5 is 0.75; the gate needs at least 0.8.';
    const out = await run(['agents', 'pin', ...SCOPE], {
      agents: {
        pinned: {
          pin: async () => {
            throw new KindgiApiError(fromWire({ code: 'gate-failed', message }, 422));
          },
        },
      },
    });
    expect(out.exitCode).toBe(3);
    expect(out.stderr).toContain(`Error [gate-failed]: ${message}`);
  });

  test('any other error is still 1', async () => {
    const out = await run(['agents', 'pin', ...SCOPE], {
      agents: {
        pinned: {
          pin: async () => {
            throw new KindgiApiError(fromWire({ code: 'forbidden', message: 'Not allowed' }, 403));
          },
        },
      },
    });
    expect(out.exitCode).toBe(1);
  });

  test('a pin that waits for an approval, without --wait: printed, exit 3, and the approval named', async () => {
    const calls: unknown[][] = [];
    const out = await run(['agents', 'pin', ...SCOPE], {
      agents: { pinned: { pin: async () => PENDING, getChange: reads(calls, 'pinned') } },
    });
    expect(out.exitCode).toBe(3);
    expect(JSON.parse(out.stdout)).toEqual(PENDING);
    expect(calls).toEqual([]);
    expect(out.stderr).toBe(
      "Approval ap-1 stays open: once it's approved, acme.drafter 1.1.0 is pinned. `--wait` waits for the decision.\n",
    );
  });

  test('--wait: reads the pin every 5 s until it is approved, exit 0, and prints it as it ended', async () => {
    const calls: unknown[][] = [];
    const { out, pauses } = await runWaiting(['agents', 'pin', ...SCOPE, '--wait=30m'], {
      agents: {
        pinned: {
          pin: async () => PENDING,
          getChange: reads(calls, 'pending-approval', 'pinned'),
        },
      },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['getChange', 'acme.drafter', 'p-1'],
      ['getChange', 'acme.drafter', 'p-1'],
    ]);
    expect(pauses).toEqual([5000, 5000]);
    expect(JSON.parse(out.stdout)).toMatchObject({ id: 'p-1', status: 'pinned' });
    expect(out.stderr).toBe(
      'Waiting up to 30m for approval ap-1 of acme.drafter 1.1.0: `kindgi approvals complete ap-1 --decision=approve` approves it.\n',
    );
  });

  test.each([
    ['rejected', "Approval ap-1 was rejected: acme.drafter 1.1.0 doesn't get pinned."],
    ['expired', "Approval ap-1 expired undecided: acme.drafter 1.1.0 doesn't get pinned."],
    [
      'superseded',
      'acme.drafter 1.1.0 was approved, but superseded: something its check measured changed before the approval. Pin it again to ask again.',
    ],
  ])('--wait: a pin that ends %s exits 3 and says how it ended', async (status, line) => {
    const calls: unknown[][] = [];
    const { out } = await runWaiting(['agents', 'pin', ...SCOPE, '--wait'], {
      agents: { pinned: { pin: async () => PENDING, getChange: reads(calls, status) } },
    });
    expect(out.exitCode).toBe(3);
    expect(JSON.parse(out.stdout)).toMatchObject({ status });
    expect(out.stderr).toContain('Waiting up to 1h for approval ap-1');
    expect(out.stderr).toContain(line);
  });

  const RECHECK = {
    name: 'approval.recheck',
    passed: false,
    message:
      "Approved, but things changed since the check: The scope's release gate is acme.drafter-prod 1.1.0 now, not the one it passed. Check again.",
  };
  const PASSED = { name: 'comparison.status', passed: true, message: 'The comparison completed.' };

  test.each([
    [
      'the approval.recheck check',
      [PASSED, RECHECK],
      "acme.drafter 1.1.0 was superseded: Approved, but things changed since the check: The scope's release gate is acme.drafter-prod 1.1.0 now, not the one it passed. Check again. Pin it again to ask again.",
    ],
    [
      'other checks, but no approval.recheck',
      [PASSED],
      'acme.drafter 1.1.0 was approved, but superseded: something its check measured changed before the approval. Pin it again to ask again.',
    ],
  ])('--wait: a superseded pin with %s says why', async (_, checks, line) => {
    const { out } = await runWaiting(['agents', 'pin', ...SCOPE, '--wait'], {
      agents: {
        pinned: {
          pin: async () => PENDING,
          getChange: async () => pin({ status: 'superseded', approvalId: 'ap-1', checks }),
        },
      },
    });
    expect(out.exitCode).toBe(3);
    expect(out.stderr).toContain(`${line}\n`);
  });

  test.each([
    ['90s', '90s'],
    ['45m', '45m'],
    ['2h', '2h'],
    ['120m', '2h'],
  ])('--wait=%s waits up to %s', async (given, said) => {
    const calls: unknown[][] = [];
    const { out } = await runWaiting(['agents', 'pin', ...SCOPE, `--wait=${given}`], {
      agents: { pinned: { pin: async () => PENDING, getChange: reads(calls, 'pinned') } },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr).toContain(`Waiting up to ${said} for approval ap-1`);
  });

  test('--wait: the wait runs out, exit 3; the approval stays open', async () => {
    const calls: unknown[][] = [];
    const { out, pauses } = await runWaiting(['agents', 'pin', ...SCOPE, '--wait=8s'], {
      agents: {
        pinned: { pin: async () => PENDING, getChange: reads(calls, 'pending-approval') },
      },
    });
    expect(out.exitCode).toBe(3);
    expect(pauses).toEqual([5000, 3000]);
    expect(out.stderr).toContain(
      "Still waiting after 8s. Approval ap-1 stays open: once it's approved, acme.drafter 1.1.0 is pinned.",
    );
  });

  test('--wait: Ctrl-C stops the wait, not the pin: exit 130', async () => {
    const controller = new AbortController();
    const calls: unknown[][] = [];
    const get = reads(calls, 'pending-approval');
    const { out } = await runWaiting(
      ['agents', 'pin', ...SCOPE, '--wait'],
      {
        agents: {
          pinned: {
            pin: async () => PENDING,
            getChange: async (...args: unknown[]) => {
              controller.abort();
              return await get(...args);
            },
          },
        },
      },
      controller.signal,
    );
    expect(out.exitCode).toBe(130);
    expect(out.stderr).toContain("Stopped waiting. Approval ap-1 stays open: once it's approved");
  });

  test('--wait: a failed read is read again at the next read, and the count starts again after one that works', async () => {
    const calls: unknown[][] = [];
    const { out, pauses } = await runWaiting(['agents', 'pin', ...SCOPE, '--wait'], {
      agents: {
        pinned: {
          pin: async () => PENDING,
          getChange: readsOrFails(
            calls,
            unavailable(),
            unavailable(),
            'pending-approval',
            unavailable(),
            unavailable(),
            'pinned',
          ),
        },
      },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toHaveLength(6);
    expect(pauses).toEqual([5000, 5000, 5000, 5000, 5000, 5000]);
    expect(JSON.parse(out.stdout)).toMatchObject({ id: 'p-1', status: 'pinned' });
  });

  test('--wait: 3 failed reads in a row end the wait, exit 1; it prints the pin as last read, and the approval stays open', async () => {
    const calls: unknown[][] = [];
    const { out, pauses } = await runWaiting(['agents', 'pin', ...SCOPE, '--wait'], {
      agents: {
        pinned: { pin: async () => PENDING, getChange: readsOrFails(calls, unavailable()) },
      },
    });
    expect(out.exitCode).toBe(1);
    expect(calls).toHaveLength(3);
    expect(pauses).toEqual([5000, 5000, 5000]);
    expect(JSON.parse(out.stdout)).toEqual(PENDING);
    expect(out.stderr).toContain("Couldn't read the pin of acme.drafter 1.1.0 3 times in a row (");
    expect(out.stderr).toContain(
      "). Approval ap-1 stays open: once it's approved, acme.drafter 1.1.0 is pinned.",
    );
  });

  test('--wait: a read refused by a rate limit is sent again once the limit says, and is no failed read', async () => {
    const calls: unknown[][] = [];
    const limited = new KindgiApiError({
      code: 'rate-limited',
      message: 'Too many requests.',
      retryAfterSeconds: 2,
    });
    const { out, pauses, slept } = await runWaiting(['agents', 'pin', ...SCOPE, '--wait'], {
      agents: {
        pinned: {
          pin: async () => PENDING,
          getChange: readsOrFails(calls, limited, limited, limited, 'pinned'),
        },
      },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toHaveLength(4);
    expect(slept).toEqual([2000, 2000, 2000]);
    expect(pauses).toEqual([5000]);
  });

  test('--wait on a pin that took effect at once reads nothing: exit 0', async () => {
    const calls: unknown[][] = [];
    const { out, pauses } = await runWaiting(['agents', 'pin', ...SCOPE, '--wait'], {
      agents: {
        pinned: {
          pin: async () => pin({ status: 'pinned' }),
          getChange: reads(calls, 'pinned'),
        },
      },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([]);
    expect(pauses).toEqual([]);
  });

  test.each([
    [['--check', '--wait'], '--check makes none'],
    [['--wait=tomorrow'], '--wait must be like 90s, 30m or 2h, got "tomorrow"'],
    [['--wait=0s'], '--wait must be like'],
  ])('%j is refused before anything is sent: exit 2', async (flags, message) => {
    const { calls, rec } = recorder();
    const out = await run(['agents', 'pin', ...SCOPE, ...flags], {
      agents: { pinned: { pin: rec('pin'), check: rec('check') } },
    });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain(message);
    expect(calls).toEqual([]);
  });
});
