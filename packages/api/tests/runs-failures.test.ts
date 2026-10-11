// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/runs/failures`: a project's failed runs grouped by cause and
 * version. What it asks the binding for, what it refuses, who may read
 * it, and that `/failures` isn't read as a run id.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { FailureGroups, FailureGroupsInput, RunBinding } from '@kindgi/runtime';
import type { TenantId, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type { TokenResolver } from '../src/index.js';
import { createStubAppBindings } from '../src/testing/index.js';

const tenantId = randomUUID() as TenantId;
const projectA = randomUUID();
const projectB = randomUUID();
const TOKEN = 'runs-failures-token';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-reader' as UserId } : null;

const ANSWER: FailureGroups = {
  groups: [
    {
      code: 'budget-exceeded',
      subject: { kind: 'agent', id: 'acme.refunds' },
      version: '2.1.0',
      count: 3,
      firstSeen: '2026-10-01T00:00:00.000Z' as never,
      lastSeen: '2026-10-02T00:00:00.000Z' as never,
      exampleRunId: randomUUID(),
    },
  ],
  outcomes: [],
  unrecorded: [],
  total: 3,
};

function grantsAuthz(grants: readonly string[]) {
  const decision = (action: Action, resource: ResourceRef): Decision => {
    const allowed = grants.includes(`${action} ${resource.type}:${resource.id}`);
    return {
      allowed,
      reason: allowed ? 'test: granted' : 'test: not granted',
      evidence: {
        action,
        relation: '',
        resource: `${resource.type}:${resource.id}`,
        actorSubject: '',
      },
    };
  };
  return {
    fgaApiUrl: 'http://fga.invalid',
    authzCheckBinding: {
      check: async (_p, action, resource) => decision(action, resource),
      checkBatch: async (_p, action, resources) => resources.map((r) => decision(action, r)),
    } satisfies AuthzCheckBinding,
  };
}

function harness(options: { grants?: readonly string[]; supported?: boolean } = {}) {
  const asked: FailureGroupsInput[] = [];
  const stubs = createStubAppBindings();
  const run = {
    ...stubs.kernelBinding.run,
    // Absent on a binding that can't group failures (the route checks for it).
    failureGroups:
      options.supported === false
        ? undefined
        : async (input: FailureGroupsInput) => {
            asked.push(input);
            return ANSWER;
          },
  } as unknown as RunBinding;
  const app = createApp({
    ...stubs,
    kernelBinding: { ...stubs.kernelBinding, run },
    resolveToken,
    runHandler: {
      invokeAgent: async () => ({ kind: 'err', code: 'agent-not-found', message: 'unused' }),
      invokeFlow: async () => ({ kind: 'err', code: 'flow-not-found', message: 'unused' }),
    } as never,
    ...(options.grants !== undefined && { authz: grantsAuthz(options.grants) }),
  });
  const get = async (query: string) => {
    const res = await app.request(`/v1/runs/failures${query}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { asked, get };
}

const WEEK = '&from=2026-10-01T00:00:00Z&to=2026-10-08T00:00:00Z';

describe('GET /v1/runs/failures', () => {
  test('asks the binding for the project, the window and the grouping; answers its groups', async () => {
    const h = harness();
    const res = await h.get(`?projectId=${projectA}${WEEK}&agentId=acme.refunds&limit=20`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-08T00:00:00.000Z',
      ...ANSWER,
    });
    expect(h.asked).toEqual([
      {
        tenantId,
        projectId: projectA,
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-08T00:00:00.000Z',
        subject: { kind: 'agent', id: 'acme.refunds' },
        groupBy: { code: true, version: true },
        limit: 20,
      },
    ]);
  });

  test('groupBy and a flow: as asked; the default limit is 50', async () => {
    const h = harness();
    expect(
      (await h.get(`?projectId=${projectA}${WEEK}&flowId=acme.flow&groupBy=version`)).status,
    ).toBe(200);
    expect(h.asked[0]).toMatchObject({
      subject: { kind: 'flow', id: 'acme.flow' },
      groupBy: { code: false, version: true },
      limit: 50,
    });
  });

  test.each([
    ['no project', '?from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z', '`projectId` is required'],
    ['no window', `?projectId=${projectA}`, '`from` and `to` are required'],
    [
      'a window backwards',
      `?projectId=${projectA}&from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z`,
      'before `to`',
    ],
    [
      'over 90 days',
      `?projectId=${projectA}&from=2026-01-01T00:00:00Z&to=2026-10-01T00:00:00Z`,
      'at most 90 days',
    ],
    ['an agent and a flow', `?projectId=${projectA}${WEEK}&agentId=a&flowId=f`, 'not both'],
    ['an unknown grouping', `?projectId=${projectA}${WEEK}&groupBy=code,node`, '`groupBy`'],
    ['a limit too high', `?projectId=${projectA}${WEEK}&limit=500`, '`limit`'],
  ])('%s: 400, saying why', async (_, query, says) => {
    const h = harness();
    const res = await h.get(query);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad-input');
    expect(res.body.error.message).toContain(says);
    expect(h.asked).toEqual([]);
  });

  test("a binding that can't group failures: 501 run-failures-not-supported", async () => {
    const res = await harness({ supported: false }).get(`?projectId=${projectA}${WEEK}`);
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('run-failures-not-supported');
  });

  test("needs read on the project: another project's are refused, and the binding isn't asked", async () => {
    // Every runs route asks for `read` on the tenant first, which a member has.
    const h = harness({ grants: [`read tenant:${tenantId}`, `read project:${projectA}`] });
    const allowed = await h.get(`?projectId=${projectA}${WEEK}`);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    const refused = await h.get(`?projectId=${projectB}${WEEK}`);
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain(`project:${projectB}`);
    expect(h.asked.map((a) => a.projectId)).toEqual([projectA]);
  });
});
