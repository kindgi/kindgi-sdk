// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { KernelRunRecord, RunBinding } from '@kindgi/runtime';
import type { RunId, TenantId } from '@kindgi/types';

/**
 * A run as `runsOf` answers it: its flow, the run that started it, and
 * for a replay's run the run it replays.
 */
export interface TestRun {
  readonly flowId: string;
  readonly parentRunId?: string;
  readonly replayOf?: string;
}

/**
 * A run binding for a handler under test that reads runs: `getRun`
 * answers `runs` by id within `tenantId`, and null for any other run or
 * tenant, as a runtime's tenant-scoped store does. Every read is kept in
 * `reads`. Nothing else is bound.
 */
export function runsOf(
  tenantId: TenantId,
  runs: Readonly<Record<string, TestRun>>,
): { readonly runBinding: RunBinding; readonly reads: string[] } {
  const reads: string[] = [];
  const runBinding = {
    getRun: async (tenant: TenantId, runId: RunId): Promise<KernelRunRecord | null> => {
      reads.push(runId as unknown as string);
      const run = tenant === tenantId ? runs[runId as unknown as string] : undefined;
      if (run === undefined) return null;
      return {
        runId,
        tenantId: tenant,
        flowId: run.flowId,
        parentRunId: (run.parentRunId ?? null) as RunId | null,
        // A runtime's record carries `replayOf` only for a replay's run.
        ...(run.replayOf !== undefined && { replayOf: run.replayOf as RunId }),
      } as unknown as KernelRunRecord;
    },
  } as unknown as RunBinding;
  return { runBinding, reads };
}
