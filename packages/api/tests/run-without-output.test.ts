// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Why a run can't be corrected, or made a test case. One check serves both
 * routes, so its words name neither: a run that ended without an output
 * says it won't have one, and only a run still going says "yet".
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { KernelRunRecord } from '@kindgi/runtime';
import type { ProjectId, RunId, TenantId, Timestamp } from '@kindgi/types';

import { unfinishedRun } from '../src/routes/corrections.js';

const at = '2026-09-30T00:00:00.000Z' as Timestamp;

function run(overrides: Partial<KernelRunRecord> = {}): KernelRunRecord {
  return {
    runId: randomUUID() as RunId,
    tenantId: randomUUID() as TenantId,
    projectId: randomUUID() as ProjectId,
    flowId: 'acme.match',
    flowVersion: '1.0.0',
    status: 'completed',
    input: { query: 'acme' },
    output: { answer: 'Refunded.' },
    dryRun: false,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

describe('unfinishedRun', () => {
  test('a completed run with an output is not refused', () => {
    expect(unfinishedRun(run(), 'r-1')).toBeUndefined();
  });

  test.each(['failed', 'cancelled'] as const)(
    'a %s run ended without an output, and says it never will',
    (status) => {
      const refused = unfinishedRun(run({ status, output: undefined }), 'r-1');
      expect(refused).toEqual({
        code: 'run-not-finished',
        message: `Run "r-1" ended without an output (status ${status}), and won't have one.`,
      });
    },
  );

  test.each(['pending', 'running', 'suspended'] as const)(
    'a %s run has no output yet',
    (status) => {
      const refused = unfinishedRun(run({ status, output: undefined }), 'r-1');
      expect(refused).toEqual({
        code: 'run-not-finished',
        message: `Run "r-1" has no output yet (status ${status}).`,
      });
    },
  );

  test.each([null, undefined])(
    'a completed run whose output is %s completed without one',
    (output) => {
      const refused = unfinishedRun(run({ output }), 'r-1');
      expect(refused).toEqual({
        code: 'run-not-finished',
        message: 'Run "r-1" completed without an output.',
      });
    },
  );

  test('an erased run is refused as erased, whatever its status', () => {
    for (const status of ['completed', 'failed'] as const) {
      const refused = unfinishedRun(run({ status, output: null, contentErasedAt: at }), 'r-1');
      expect(refused).toEqual({
        code: 'run-erased',
        message: `Run "r-1" was erased (a person's words were removed): its content is gone.`,
      });
    }
  });

  test('no refusal names correcting, since a test case is refused by the same words', () => {
    const statuses = [
      'pending',
      'running',
      'suspended',
      'completed',
      'failed',
      'cancelled',
    ] as const;
    for (const status of statuses) {
      for (const erased of [false, true]) {
        const refused = unfinishedRun(
          run({ status, output: null, ...(erased && { contentErasedAt: at }) }),
          'r-1',
        );
        expect(refused?.message, `${status}, erased ${erased}`).not.toMatch(/correct/i);
      }
    }
  });
});
