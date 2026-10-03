// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/runs/:runId/stream` falls back to polling the journal when
 * the event bus is wired but subscribing fails.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { JournalEntry, KernelRunRecord, RunBinding } from '@kindgi/runtime';
import type { ProjectId, RunId, TenantId, Timestamp } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import { createApp } from '../src/index.js';
import type { EventBusBinding, RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'runs-stream-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

function entry(sequence: number, kind: string): JournalEntry {
  return {
    sequence,
    kind,
    timestamp: new Date(Date.UTC(2026, 8, 30, 12, 0, sequence)).toISOString() as Timestamp,
  } as unknown as JournalEntry;
}

describe('GET /v1/runs/:runId/stream — event bus subscribe fails', () => {
  test('falls back to polling and delivers the run to its terminal event', async () => {
    const runId = randomUUID() as RunId;
    const at = '2026-09-30T00:00:00.000Z' as Timestamp;
    const record: KernelRunRecord = {
      runId,
      tenantId,
      projectId: randomUUID() as ProjectId,
      flowId: 'pack.flow',
      flowVersion: '1.0.0',
      status: 'running',
      input: {},
      dryRun: false,
      createdAt: at,
      updatedAt: at,
    };
    // The run completes after the stream opened: the first journal read
    // (the backfill) sees it running, later reads see it completed.
    let reads = 0;
    const stubs = createStubAppBindings();
    const run = {
      ...stubs.kernelBinding.run,
      getRun: async () => record,
      readJournal: async () => {
        reads += 1;
        const journal = [entry(1, 'run.started')];
        if (reads > 1) journal.push(entry(2, 'run.completed'));
        return { kind: 'ok' as const, value: journal };
      },
    } as unknown as RunBinding;
    const eventBus: EventBusBinding = {
      publish: async () => ({ kind: 'ok', value: undefined }),
      subscribe: async () => ({
        kind: 'err',
        error: { code: 'subscribe-failed', message: 'bus unavailable' },
      }),
    };
    const app = createApp({
      ...stubs,
      kernelBinding: { ...stubs.kernelBinding, run },
      resolveToken,
      runHandler: {} as RunHandlerBinding,
      eventBus,
    });

    const res = await app.request(`/v1/runs/${runId}/stream`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: run.started');
    expect(text).toContain('event: run.completed');
  });
});
