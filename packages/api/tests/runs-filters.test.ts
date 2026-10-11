// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/runs` narrowing filters: `status` (one or a comma list), the
 * strict creation bounds, `agentVersion` (with `agentId`), `flowId` and
 * `flowVersion` (with `flowId`): checked, then handed to the binding.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { ListRunsInput, RunBinding } from '@kindgi/runtime';
import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'runs-filters-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

async function list(query: string) {
  const stubs = createStubAppBindings();
  const listed: ListRunsInput[] = [];
  const run = {
    ...stubs.kernelBinding.run,
    listRuns: async (input: ListRunsInput) => {
      listed.push(input);
      return { data: [], hasMore: false };
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
    json: (await res.json()) as { error?: { message?: string } },
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
      'agentVersion',
      'flowId',
      'flowVersion',
    ]) {
      expect(r.input, key).not.toHaveProperty(key);
    }
  });
});
