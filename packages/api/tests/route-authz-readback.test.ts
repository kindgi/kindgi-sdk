// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Readback and authorization (T243 A): observations, cost records and
 * provenance show only what the caller may read.
 *
 *   - Observations: those of agents the caller may read.
 *   - Cost: a record needs `read` on its project (the tenant, for one
 *     with no project), and the list is filtered the same way; an
 *     aggregate needs `read` on the scope it asks about.
 *   - Provenance: a run's record and its export need `read` on the run's
 *     project (a run that isn't there is the handler's 404, behind `read`
 *     on the tenant); the list holds only records the caller may read.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { KernelRunRecord, RunBinding } from '@kindgi/runtime';
import { createStubAppBindings } from '@kindgi/testing';
import type { TenantId, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'route-authz-readback';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId } : null;
const MINE = randomUUID();
const THEIRS = randomUUID();
const RUN_MINE = randomUUID();
const RUN_THEIRS = randomUUID();
const TENANT_READ = `read tenant:${tenantId}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const observation = (id: string, agentId: string) => ({
  id,
  tenantId,
  supervisorId: 'acme.supervisor',
  agentId,
  agentVersion: '1.0.0',
  conversationId: randomUUID(),
  turnNumber: 1,
  status: 'pass',
  violations: [],
  durationMs: 1,
  costUsd: 0,
  observedAt: '2026-10-08T08:00:00.000Z',
});

const costRecord = (id: string, projectId?: string) => ({
  id,
  tenantId,
  category: 'model',
  quantity: 1,
  unit: 'call',
  occurredAt: '2026-10-08T08:00:00.000Z',
  ...(projectId !== undefined && { projectId }),
});

const provenanceRecord = (runId: string, projectId?: string) => ({
  id: randomUUID(),
  runId,
  tenantId,
  version: '1.0.0',
  createdAt: '2026-10-08T08:00:00.000Z',
  signed: false,
  ...(projectId !== undefined && { projectId }),
});

const NO_TOKENS = { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

function harness(grants: readonly string[]) {
  const decide = (action: Action, r: ResourceRef): Decision => {
    const allowed = grants.includes(`${action} ${r.type}:${r.id}`);
    return {
      allowed,
      reason: allowed ? 'test: granted' : 'test: not granted',
      evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
    };
  };
  const stubs = createStubAppBindings();
  const runs: Record<string, string> = { [RUN_MINE]: MINE, [RUN_THEIRS]: THEIRS };
  const run = {
    ...stubs.kernelBinding.run,
    // As Postgres's uuid cast does, a malformed id fails the query.
    getRun: async (_t: TenantId, runId: string) => {
      if (!UUID.test(runId)) throw new Error(`invalid input syntax for type uuid: "${runId}"`);
      return runs[runId] === undefined ? null : ({ projectId: runs[runId] } as KernelRunRecord);
    },
  } as unknown as RunBinding;
  const costs = [
    costRecord('c-mine', MINE),
    costRecord('c-theirs', THEIRS),
    costRecord('c-tenant'),
  ];
  const app = createApp({
    ...stubs,
    kernelBinding: { ...stubs.kernelBinding, run },
    enableObservations: true,
    supervisor: {
      queryObservations: async () => ({
        kind: 'ok',
        page: {
          data: [observation('o-mine', 'acme.mine'), observation('o-theirs', 'acme.theirs')],
        },
      }),
    } as never,
    cost: {
      listRecords: async () => ({ data: costs }),
      getRecord: async ({ recordId }: { recordId: string }) => costs.find((r) => r.id === recordId),
      aggregate: async () => ({
        groups: [],
        totalGroups: 0,
        totalUsd: 0,
        totalRecords: 0,
        tokens: NO_TOKENS,
        timeRange: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' },
      }),
    } as never,
    provenanceBinding: {
      listRecords: async () => ({
        kind: 'ok',
        value: {
          records: [
            provenanceRecord(RUN_MINE, MINE),
            provenanceRecord(RUN_THEIRS, THEIRS),
            provenanceRecord(randomUUID()),
          ],
        },
      }),
      getByRunId: async () => ({
        kind: 'err',
        error: { code: 'provenance-not-found', message: 'no provenance for that run' },
      }),
    } as never,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    authz: {
      fgaApiUrl: 'http://fga.invalid',
      authzCheckBinding: {
        check: async (_p, action, r) => decide(action, r),
        checkBatch: async (_p, action, rs) => rs.map((r) => decide(action, r)),
      } satisfies AuthzCheckBinding,
    },
  });
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const ids = async (res: Response) =>
    ((await res.json()) as { data: { id: string; runId?: string }[] }).data.map(
      (row) => row.runId ?? row.id,
    );
  return { call, ids };
}

describe('observations hold only agents the caller may read', () => {
  test('the list is filtered by `read` on each agent', async () => {
    const { call, ids } = harness(['read agent:acme.mine']);
    const res = await call('GET', '/v1/observations');
    expect(res.status).toBe(200);
    expect(await ids(res)).toEqual(['o-mine']);
  });
});

describe('cost records need `read` on their project (the tenant without one)', () => {
  test('the list holds only those', async () => {
    const { call, ids } = harness([`read project:${MINE}`]);
    const res = await call('GET', '/v1/cost/records');
    expect(res.status).toBe(200);
    expect(await ids(res)).toEqual(['c-mine']);

    const withTenant = harness([`read project:${MINE}`, TENANT_READ]);
    const all = await withTenant.call('GET', '/v1/cost/records');
    expect(await withTenant.ids(all)).toEqual(['c-mine', 'c-tenant']);
  });

  test("another project's record is refused (403); one's own is served", async () => {
    const { call } = harness([`read project:${MINE}`]);
    expect((await call('GET', '/v1/cost/records/c-theirs')).status).toBe(403);
    expect((await call('GET', '/v1/cost/records/c-tenant')).status).toBe(403);
    expect((await call('GET', '/v1/cost/records/c-mine')).status).toBe(200);
  });

  test('an aggregate needs `read` on the scope it asks about', async () => {
    const { call } = harness([`read project:${MINE}`]);
    const aggregate = (scope: string) => call('GET', `/v1/cost/aggregate?groupBy=category${scope}`);
    expect((await aggregate(`&scopeKind=project&scopeId=${THEIRS}`)).status).toBe(403);
    expect((await aggregate('')).status).toBe(403);
    expect((await aggregate(`&scopeKind=project&scopeId=${MINE}`)).status).toBe(200);
    expect(
      (await harness([TENANT_READ]).call('GET', '/v1/cost/aggregate?groupBy=category')).status,
    ).toBe(200);
  });
});

describe("provenance needs `read` on the run's project", () => {
  test('the list holds only those (the tenant, for a record with no project)', async () => {
    const { call, ids } = harness([`read project:${MINE}`]);
    const res = await call('GET', '/v1/provenance');
    expect(res.status).toBe(200);
    expect(await ids(res)).toEqual([RUN_MINE]);
  });

  test("another project's run: its record and its export are refused (403)", async () => {
    const { call } = harness([`read project:${MINE}`]);
    expect((await call('GET', `/v1/provenance/${RUN_THEIRS}`)).status).toBe(403);
    expect((await call('POST', `/v1/provenance/${RUN_THEIRS}/export`, {})).status).toBe(403);
  });

  test("one's own run passes the check (here the handler's 404: no record yet)", async () => {
    const { call } = harness([`read project:${MINE}`]);
    expect((await call('GET', `/v1/provenance/${RUN_MINE}`)).status).toBe(404);
    expect((await call('POST', `/v1/provenance/${RUN_MINE}/export`, {})).status).not.toBe(403);
  });

  test("an id that isn't a run id is never looked up: the handler answers, not a 500", async () => {
    const { call } = harness([TENANT_READ]);
    expect((await call('GET', '/v1/provenance/None')).status).toBe(404);
  });

  test('a run that is not there is the handler’s 404, behind `read` on the tenant', async () => {
    const missing = randomUUID();
    expect((await harness([]).call('GET', `/v1/provenance/${missing}`)).status).toBe(403);
    expect((await harness([TENANT_READ]).call('GET', `/v1/provenance/${missing}`)).status).toBe(
      404,
    );
  });
});
