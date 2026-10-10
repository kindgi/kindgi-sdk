// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A run a trigger started names the trigger and the fire: the record's
 * `trigger` is on the wire as `Run.trigger`, and `GET /v1/runs?triggerId=`
 * lists one trigger's runs.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { KernelRunRecord, ListRunsInput, RunBinding } from '@kindgi/runtime';
import type { ProjectId, RunId, TenantId, Timestamp, TriggerId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'runs-trigger-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

const triggerId = randomUUID() as TriggerId;
const fired: KernelRunRecord = {
  runId: randomUUID() as RunId,
  tenantId,
  projectId: randomUUID() as ProjectId,
  flowId: 'acme.digest',
  flowVersion: '1.0.0',
  status: 'completed',
  input: {},
  dryRun: false,
  createdAt: '2026-10-07T07:00:01.000Z' as Timestamp,
  updatedAt: '2026-10-07T07:00:02.000Z' as Timestamp,
  trigger: {
    triggerId,
    kind: 'schedule',
    fireId: 'f-1',
    scheduledFor: '2026-10-07T07:00:00.000Z' as Timestamp,
  },
};

function app() {
  const stubs = createStubAppBindings();
  const listed: ListRunsInput[] = [];
  const run = {
    ...stubs.kernelBinding.run,
    getRun: async (_t: TenantId, runId: string) => (runId === fired.runId ? fired : null),
    listRuns: async (input: ListRunsInput) => {
      listed.push(input);
      return { data: [fired], hasMore: false };
    },
  } as unknown as RunBinding;
  const built = createApp({
    ...stubs,
    kernelBinding: { ...stubs.kernelBinding, run },
    resolveToken,
    runHandler: {} as RunHandlerBinding,
  });
  return { built, listed };
}

async function get(path: string) {
  const h = app();
  const res = await h.built.request(path, { headers: { authorization: `Bearer ${TOKEN}` } });
  return { status: res.status, json: (await res.json()) as Record<string, unknown>, ...h };
}

describe('a run names the trigger that started it', () => {
  test('the run carries trigger: its id, kind, fire and occurrence', async () => {
    const answer = await get(`/v1/runs/${fired.runId}`);
    expect(answer.status).toBe(200);
    expect(answer.json.trigger).toEqual({
      triggerId,
      kind: 'schedule',
      fireId: 'f-1',
      scheduledFor: '2026-10-07T07:00:00.000Z',
    });
  });

  test("?triggerId= lists one trigger's runs", async () => {
    const answer = await get(`/v1/runs?triggerId=${triggerId}`);
    expect(answer.status).toBe(200);
    expect(answer.listed[0]?.triggerId).toBe(triggerId);
  });

  test('a triggerId that is not a UUID is a 400', async () => {
    const answer = await get('/v1/runs?triggerId=nope');
    expect(answer.status).toBe(400);
  });
});
