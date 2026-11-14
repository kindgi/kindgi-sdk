// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/runs` narrowing filters: `status` (one or a comma list), the
 * strict creation bounds, the completion bounds (with `afterRunId`),
 * `startedBy`, `agentVersion` (with `agentId`), `flowId` and
 * `flowVersion` (with `flowId`): checked, then handed to the binding.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { ListRunsInput, RunBinding } from '@kindgi/runtime';
import type { TenantId } from '@kindgi/types';

import { encodeCursor } from '../src/routes/pagination.js';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'runs-filters-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

async function list(query: string, page: { nextCursor?: string } = {}) {
  const stubs = createStubAppBindings();
  const listed: ListRunsInput[] = [];
  const run = {
    ...stubs.kernelBinding.run,
    listRuns: async (input: ListRunsInput) => {
      listed.push(input);
      return { data: [], hasMore: page.nextCursor !== undefined, ...page };
    },
  } as unknown as RunBinding;
  const app = createApp({
    ...stubs,
    kernelBinding: { ...stubs.kernelBinding, run },
    resolveToken,
    runHandler: {} as RunHandlerBinding,
  });
  const res = await app.request(`/v1/runs?${query}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return {
    status: res.status,
    json: (await res.json()) as {
      error?: { message?: string };
      hasMore?: boolean;
      nextCursor?: string;
    },
    input: listed[0],
  };
}

describe('GET /v1/runs: the narrowing filters', () => {
  test('status: one, repeated, or a comma list, de-duplicated', async () => {
    expect((await list('status=failed')).input?.statuses).toEqual(['failed']);
    expect((await list('status=failed,cancelled,failed')).input?.statuses).toEqual([
      'failed',
      'cancelled',
    ]);
    expect((await list('status=failed&status=cancelled')).input?.statuses).toEqual([
      'failed',
      'cancelled',
    ]);
    const bad = await list('status=failed,crashed');
    expect(bad.status).toBe(400);
    expect(bad.json.error?.message).toBe(
      'Unknown `status` value(s): crashed. Expected one or more of: pending, running, suspended, completed, failed, cancelled',
    );
    expect((await list('status=')).status).toBe(400);
  });

  test('the creation bounds: strict, as ISO times, after before before', async () => {
    const r = await list(
      'createdAfter=2026-10-01T00:00:00Z&createdBefore=2026-10-08T12:30:00.000%2B02:00',
    );
    expect(r.input).toMatchObject({
      createdAfter: '2026-10-01T00:00:00.000Z',
      createdBefore: '2026-10-08T10:30:00.000Z',
    });
    expect((await list('createdAfter=yesterday')).status).toBe(400);
    const crossed = await list(
      'createdAfter=2026-10-08T00:00:00Z&createdBefore=2026-10-01T00:00:00Z',
    );
    expect(crossed.status).toBe(400);
    expect(crossed.json.error?.message).toBe('`createdAfter` must be earlier than `createdBefore`');
  });

  test('the completion bounds: kept as given, after strictly with its tie-break, before inclusive', async () => {
    const runId = randomUUID();
    const r = await list(
      `completedAfter=2026-10-08T10:30:00.123456Z&afterRunId=${runId}&completedBefore=2026-10-08T11:00:00Z`,
    );
    expect(r.status).toBe(200);
    expect(r.input).toMatchObject({
      completedAfter: '2026-10-08T10:30:00.123456Z',
      afterRunId: runId,
      completedBefore: '2026-10-08T11:00:00Z',
    });
    expect(
      (await list('completedAfter=2026-10-08T11:00:00Z&completedBefore=2026-10-08T11:00:00Z'))
        .status,
    ).toBe(200);
    const crossed = await list(
      'completedAfter=2026-10-08T11:00:01Z&completedBefore=2026-10-08T11:00:00Z',
    );
    expect(crossed.status).toBe(400);
    expect(crossed.json.error?.message).toBe(
      '`completedAfter` must not be later than `completedBefore`',
    );
    expect((await list('completedAfter=1')).json.error?.message).toBe(
      '`completedAfter` must be a date-time',
    );
    expect((await list('completedBefore=2026-10-08')).json.error?.message).toBe(
      '`completedBefore` must be a date-time',
    );
    expect((await list(`afterRunId=${runId}`)).json.error?.message).toBe(
      '`afterRunId` needs `completedAfter`',
    );
    expect(
      (await list('completedAfter=2026-10-08T11:00:00Z&afterRunId=r-1')).json.error?.message,
    ).toBe('`afterRunId` must be a run id (a UUID)');
  });

  test('ordered by when runs ended, a page goes on by `completedAfter` and `afterRunId`, never a cursor', async () => {
    const cursor = encodeCursor({ createdAt: '2026-10-08T10:00:00.000Z', id: randomUUID() });
    const both = await list(`completedAfter=2026-10-08T11:00:00Z&cursor=${cursor}`);
    expect(both.status).toBe(400);
    expect(both.json.error?.message).toMatch(
      /^`cursor` cannot be combined with `completedAfter` or `completedBefore`/,
    );
    expect((await list(`completedBefore=2026-10-08T11:00:00Z&cursor=${cursor}`)).status).toBe(400);
    const more = { nextCursor: cursor };
    const byCompletion = await list('completedAfter=2026-10-08T11:00:00Z', more);
    expect(byCompletion.json.hasMore).toBe(true);
    expect(byCompletion.json).not.toHaveProperty('nextCursor');
    const byCreation = await list('createdAfter=2026-10-08T11:00:00Z', more);
    expect(byCreation.json).toMatchObject({ hasMore: true, nextCursor: cursor });
  });

  test('startedBy: one of the ways a run starts', async () => {
    expect((await list('startedBy=schedule')).input?.startedBy).toBe('schedule');
    expect((await list('startedBy=robot')).json.error?.message).toBe(
      '`startedBy` must be one of: person, key, schedule, webhook, event, mail, text',
    );
  });

  test('a version needs its id', async () => {
    expect((await list('agentId=acme.refunds&agentVersion=2.1.0')).input).toMatchObject({
      agentId: 'acme.refunds',
      agentVersion: '2.1.0',
    });
    expect((await list('agentVersion=2.1.0')).json.error?.message).toBe(
      '`agentVersion` needs `agentId`',
    );
    expect((await list('flowId=acme.digest&flowVersion=1.0.0')).input).toMatchObject({
      flowId: 'acme.digest',
      flowVersion: '1.0.0',
    });
    expect((await list('flowVersion=1.0.0')).json.error?.message).toBe(
      '`flowVersion` needs `flowId`',
    );
    expect((await list('flowId=%20')).status).toBe(400);
  });

  test('without them, the binding is asked as before', async () => {
    const r = await list('agentId=acme.refunds');
    expect(r.status).toBe(200);
    for (const key of [
      'statuses',
      'createdAfter',
      'createdBefore',
      'completedAfter',
      'afterRunId',
      'completedBefore',
      'startedBy',
      'agentVersion',
      'flowId',
      'flowVersion',
    ]) {
      expect(r.input, key).not.toHaveProperty(key);
    }
  });
});
