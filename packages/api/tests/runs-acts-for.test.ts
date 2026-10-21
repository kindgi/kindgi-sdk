// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Whom a run acts for (`actsFor`), as `GET /v1/runs/{runId}` and
 * `GET /v1/runs` answer it: the id the run records, `user:<id>` or
 * `service_account:<id>`, never a name. A person or a service account's
 * key that started it, a trigger's owner (an event's too), a parent's for
 * a child run. A run that acts for no one (a replay run, one from before
 * runs recorded it) has none.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { KernelRunRecord, RunBinding } from '@kindgi/runtime';
import type {
  NodeId,
  ProjectId,
  RunId,
  TenantId,
  Timestamp,
  TriggerId,
  UserId,
} from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const projectId = randomUUID() as ProjectId;
const PERSON = randomUUID();
const OWNER = randomUUID();
const at = '2026-10-05T08:00:00.000Z' as Timestamp;

function runRow(overrides: Partial<KernelRunRecord>): KernelRunRecord {
  return {
    runId: randomUUID() as RunId,
    tenantId,
    projectId,
    flowId: 'acme.triage',
    flowVersion: '1.0.0',
    status: 'completed',
    input: {},
    dryRun: false,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

const byPerson = runRow({ startedBy: 'person', actsFor: `user:${PERSON}` });
const byKey = runRow({ startedBy: 'key', actsFor: 'service_account:sa-automation' });
const byEvent = runRow({
  startedBy: 'event',
  trigger: { triggerId: randomUUID() as TriggerId, kind: 'event', fireId: 'fire-1' },
  actsFor: `user:${OWNER}`,
});
const child = runRow({
  parentRunId: byPerson.runId,
  parentNodeId: 'refund' as NodeId,
  startedBy: 'person',
  actsFor: `user:${PERSON}`,
});
const replay = runRow({ replayOf: byPerson.runId, evalRunId: 'eval-1' });
const older = runRow({});
const rows = [byPerson, byKey, byEvent, child, replay, older];

function allow(action: Action, resource: ResourceRef): Decision {
  return {
    allowed: true,
    reason: 'test: granted',
    evidence: {
      action,
      relation: '',
      resource: `${resource.type}:${resource.id}`,
      actorSubject: '',
    },
  };
}

function makeApp() {
  const stub = createStubAppBindings();
  const kernelRuns = {
    ...stub.kernelBinding.run,
    getRun: async (_t: TenantId, id: string) => rows.find((r) => r.runId === id) ?? null,
    listRuns: async () => ({ data: rows }),
  } as unknown as RunBinding;
  return createApp({
    ...stub,
    kernelBinding: { ...stub.kernelBinding, run: kernelRuns },
    // These routes only read runs: nothing starts or resumes one.
    runHandler: {} as RunHandlerBinding,
    resolveToken: async (token) =>
      token === 'session' ? { tenantId, userId: randomUUID() as UserId } : null,
    authz: {
      fgaApiUrl: 'http://fga.invalid',
      authzCheckBinding: {
        check: async (_p, action, resource) => allow(action, resource),
        checkBatch: async (_p, action, resources) => resources.map((r) => allow(action, r)),
      } satisfies AuthzCheckBinding,
    },
  });
}

async function get(app: ReturnType<typeof createApp>, path: string) {
  const res = await app.request(path, { headers: { authorization: 'Bearer session' } });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('GET /v1/runs/{runId}: whom the run acts for', () => {
  test.each([
    ['a person started it', byPerson, `user:${PERSON}`],
    ["a service account's key started it", byKey, 'service_account:sa-automation'],
    ["an event trigger fired it: the trigger's owner", byEvent, `user:${OWNER}`],
    ["a child run: its parent's", child, `user:${PERSON}`],
  ] as const)('%s', async (_how, row, actsFor) => {
    const res = await get(makeApp(), `/v1/runs/${row.runId}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.actsFor).toBe(actsFor);
  });

  test.each([
    ['a replay run, which records no one', replay],
    ['a run from before runs recorded it', older],
  ] as const)('%s: no actsFor', async (_how, row) => {
    const res = await get(makeApp(), `/v1/runs/${row.runId}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).not.toHaveProperty('actsFor');
  });
});

describe('GET /v1/runs: each run with whom it acts for', () => {
  test('the list carries the same field, absent where the run has none', async () => {
    const res = await get(makeApp(), '/v1/runs');
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const data = res.json.data as Record<string, unknown>[];
    expect(data.map((r) => [r.id, r.actsFor])).toEqual(rows.map((r) => [r.runId, r.actsFor]));
    expect(data.find((r) => r.id === replay.runId)).not.toHaveProperty('actsFor');
  });
});
