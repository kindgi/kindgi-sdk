// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { TenantId } from '@kindgi/types';
import { describe, expect, test } from 'vitest';

import { type ModelUsageRecord, type UsageSink, recordModelUsage } from '../src/index.js';

const call: ModelUsageRecord = {
  callId: '5b0c1a52-7d0e-4c55-9d43-2f1f6a7b9e10',
  tenantId: 'tenant-acme' as TenantId,
  providerId: 'acme',
  model: 'acme-1',
  occurredAt: '2026-10-04T12:00:00.000Z',
  status: 'ok',
  durationMs: 10,
};

/** A sink that fails its first `failures` records. */
function flakySink(failures: number): UsageSink & { readonly tries: ModelUsageRecord[] } {
  const tries: ModelUsageRecord[] = [];
  return {
    tries,
    async record(record) {
      tries.push(record);
      if (tries.length <= failures) throw new Error(`sink down (${tries.length})`);
    },
  };
}

describe('recordModelUsage', () => {
  test('tries a sink that failed again: the same record, so it counts once', async () => {
    const sink = flakySink(2);
    expect(await recordModelUsage(sink, call, { backoffMs: 1 })).toEqual({
      kind: 'ok',
      value: undefined,
    });
    expect(sink.tries).toEqual([call, call, call]);
  });

  test('when every try fails, err with the last failure', async () => {
    const sink = flakySink(99);
    const recorded = await recordModelUsage(sink, call, { tries: 2, backoffMs: 1 });
    expect(recorded.kind).toBe('err');
    if (recorded.kind === 'err') expect((recorded.error as Error).message).toBe('sink down (2)');
    expect(sink.tries).toHaveLength(2);
  });
});
