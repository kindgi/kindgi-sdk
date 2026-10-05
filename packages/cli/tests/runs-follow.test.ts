// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Run } from '@kindgi/client';
import { describe, expect, test } from 'vitest';

import { followRun, runsGetHint } from '../src/runs/follow.js';

const run = (status: string, extra: Record<string, unknown> = {}) =>
  ({ id: 'run-7', status, ...extra }) as unknown as Run;
const instant = { pauseMs: () => 0, sleep: async () => {} };

describe('followRun', () => {
  test('a run that already settled is returned as started, with no read', async () => {
    let reads = 0;
    const settled = await followRun(run('completed'), {
      ...instant,
      get: async () => {
        reads += 1;
        return run('completed');
      },
    });
    expect(settled.status).toBe('completed');
    expect(reads).toBe(0);
  });

  test.each(['completed', 'failed', 'cancelled', 'suspended'])(
    'it stops at %s (suspended: waiting on an approval, where a waiting start answered)',
    async (status) => {
      const states = ['running', status];
      const settled = await followRun(run('pending'), {
        ...instant,
        get: async () => run(states.shift() ?? status),
      });
      expect(settled.status).toBe(status);
    },
  );

  test('reads that fail now and then are retried', async () => {
    const answers: (() => Run)[] = [
      () => {
        throw new Error('ECONNRESET');
      },
      () => run('running'),
      () => {
        throw new Error('ECONNRESET');
      },
      () => run('completed'),
    ];
    const settled = await followRun(run('running'), {
      ...instant,
      get: async () => (answers.shift() as () => Run)(),
    });
    expect(settled.status).toBe('completed');
  });

  test('five failed reads in a row: it stops, naming the run that goes on and how to look at it', async () => {
    await expect(
      followRun(run('running'), {
        ...instant,
        get: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:4000');
        },
      }),
    ).rejects.toThrow(
      'could not follow run run-7: connect ECONNREFUSED 127.0.0.1:4000. The run goes on: kindgi runs get run-7',
    );
  });

  test('the pauses grow to 2 s', async () => {
    const pauses: number[] = [];
    const states = ['running', 'running', 'running', 'running', 'running', 'completed'];
    await followRun(run('running'), {
      sleep: async (ms) => {
        pauses.push(ms);
      },
      get: async () => run(states.shift() ?? 'completed'),
    });
    expect(pauses).toEqual([250, 500, 1_000, 2_000, 2_000, 2_000]);
  });

  test('runsGetHint', () => {
    expect(runsGetHint('run-7')).toBe('kindgi runs get run-7');
  });
});
