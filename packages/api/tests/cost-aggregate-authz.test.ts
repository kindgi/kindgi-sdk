// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `/v1/cost/aggregate` with authorization on: across projects (no scope,
 * or an org), it counts only the projects the caller may read, applied in
 * the binding's query (`readableProjectIds`); a tenant admin's counts them
 * all. Records with no project are the tenant's, as `/v1/cost/records`
 * reads them. Both ways of working out the projects: the authorizer's list
 * (`listObjects`), and each project checked.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { Project, ProjectBinding } from '@kindgi/platform';
import type { OrgId, ProjectId, TenantId, Timestamp, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  CostAggregateGroup,
  CostAggregateInput,
  CostBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const orgO = randomUUID() as OrgId;
const projectA = randomUUID() as ProjectId;
const projectB = randomUUID() as ProjectId;

const MEMBER = 'member-token';
const ADMIN = 'admin-token';
const ADMIN_KEY_A = 'admin-key-for-a';

const resolveToken: TokenResolver = async (token) => {
  if (token === MEMBER) return { tenantId, userId: 'member-1' as UserId };
  if (token === ADMIN) return { tenantId, userId: 'admin-1' as UserId };
  // The admin's API key, limited to project A.
  if (token === ADMIN_KEY_A)
    return { tenantId, userId: 'admin-1' as UserId, tokenProjectId: projectA };
  return null;
};

/** `action type:id` pairs each principal holds. */
const GRANTS: Readonly<Record<string, readonly string[]>> = {
  'member-1': [`read tenant:${tenantId}`, `read org:${orgO}`, `read project:${projectA}`],
  'admin-1': [
    `admin tenant:${tenantId}`,
    `read tenant:${tenantId}`,
    `read org:${orgO}`,
    `read project:${projectA}`,
    `read project:${projectB}`,
  ],
};

function holder(principal: unknown): string {
  return (principal as { actor: { id: string } }).actor.id;
}

function decision(principal: unknown, action: Action, resource: ResourceRef): Decision {
  const allowed = (GRANTS[holder(principal)] ?? []).includes(
    `${action} ${resource.type}:${resource.id}`,
  );
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
}

const checkOnly: AuthzCheckBinding = {
  check: async (principal, action, resource) => decision(principal, action, resource),
  checkBatch: async (principal, action, resources) =>
    resources.map((resource) => decision(principal, action, resource)),
};

/** The same grants, listed: the `ListObjects` path. */
const withList: AuthzCheckBinding = {
  ...checkOnly,
  listObjects: async (principal, action, type) =>
    (GRANTS[holder(principal)] ?? []).flatMap((g) => {
      const [a, r] = g.split(' ') as [string, string];
      const [t, id] = r.split(':') as [string, string];
      return a === action && t === type ? [id] : [];
    }),
};

interface Rec {
  readonly projectId?: ProjectId;
  readonly agentId: string;
  readonly model: string;
  readonly costUsd: number;
}

/** Two in project A, one in B, one with no project (the tenant's own). */
const RECORDS: readonly Rec[] = [
  { projectId: projectA, agentId: 'agent-a', model: 'model-a', costUsd: 1 },
  { projectId: projectA, agentId: 'agent-a', model: 'model-a', costUsd: 1 },
  { projectId: projectB, agentId: 'agent-b', model: 'model-b', costUsd: 5 },
  { agentId: 'agent-t', model: 'model-t', costUsd: 0.5 },
];
const ORG_OF: Readonly<Record<string, OrgId>> = { [projectA]: orgO, [projectB]: orgO };

const NO_TOKENS = { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

/** A binding that aggregates `RECORDS` as the runtime's query does, and keeps each input. */
function costBinding(appliesReadable = true): {
  binding: CostBinding;
  inputs: CostAggregateInput[];
} {
  const inputs: CostAggregateInput[] = [];
  const binding: CostBinding = {
    listRecords: async () => ({ data: [] }),
    getRecord: async () => null,
    aggregate: async (input) => {
      inputs.push(input);
      const { scope, readableProjectIds: readable } = input;
      const counted = RECORDS.filter((r) => {
        if (scope?.kind === 'project' && r.projectId !== scope.projectId) return false;
        if (
          scope?.kind === 'org' &&
          (r.projectId === undefined || ORG_OF[r.projectId] !== scope.orgId)
        )
          return false;
        if (appliesReadable && readable !== undefined && r.projectId !== undefined)
          return readable.includes(r.projectId);
        return true;
      });
      const groups = new Map<string, CostAggregateGroup>();
      for (const r of counted) {
        const key = Object.fromEntries(
          input.groupBy.map((d) => [
            d,
            d === 'projectId' ? (r.projectId ?? null) : d === 'agentId' ? r.agentId : r.model,
          ]),
        );
        const id = JSON.stringify(key);
        const g = groups.get(id);
        groups.set(id, {
          key,
          count: (g?.count ?? 0) + 1,
          totalUsd: (g?.totalUsd ?? 0) + r.costUsd,
          tokens: NO_TOKENS,
        });
      }
      return {
        groups: [...groups.values()],
        totalUsd: counted.reduce((sum, r) => sum + r.costUsd, 0),
        totalRecords: counted.length,
        tokens: NO_TOKENS,
        timeRange: {
          from: input.from.toISOString() as Timestamp,
          to: input.to.toISOString() as Timestamp,
        },
      };
    },
    ...(appliesReadable && { aggregatesReadableProjects: true }),
  };
  return { binding, inputs };
}

function harness(opts: {
  readonly authz: AuthzCheckBinding;
  readonly appliesReadable?: boolean;
  readonly withProjects?: boolean;
}) {
  const { binding, inputs } = costBinding(opts.appliesReadable ?? true);
  const projectBinding = {
    list: async () => ({
      items: [projectA, projectB].map(
        (id) => ({ id, tenantId, orgId: orgO }) as unknown as Project,
      ),
    }),
  } as unknown as ProjectBinding;
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    cost: binding,
    ...(opts.withProjects !== false && { projectBinding }),
    authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding: opts.authz },
  });
  const aggregate = async (token: string, query = '') => {
    const res = await app.request(`/v1/cost/aggregate?groupBy=agentId,model,projectId${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { aggregate, inputs };
}

/** Every value any group's key holds. */
function keyValues(body: Record<string, any>): string[] {
  return (body.groups as { key: Record<string, string | null> }[]).flatMap((g) =>
    Object.values(g.key).filter((v): v is string => v !== null),
  );
}

describe.each([
  ['the authorizer lists the projects', withList],
  ['each project is checked', checkOnly],
])('cost aggregate across projects, when %s', (_, authz) => {
  test("a member counts only the projects they may read, and no other project's agent or model appears", async () => {
    const h = harness({ authz });
    const res = await h.aggregate(MEMBER);
    expect(res.status).toBe(200);
    expect(res.body.totalUsd).toBe(2.5);
    expect(res.body.totalRecords).toBe(3);
    expect(keyValues(res.body)).not.toContain('agent-b');
    expect(keyValues(res.body)).not.toContain('model-b');
    expect(keyValues(res.body)).not.toContain(projectB);
    expect(h.inputs.at(-1)?.readableProjectIds).toEqual([projectA]);
  });

  test("an org scope counts only the org's projects the member may read", async () => {
    const h = harness({ authz });
    const res = await h.aggregate(MEMBER, `&scopeKind=org&scopeId=${orgO}`);
    expect(res.status).toBe(200);
    expect(res.body.totalUsd).toBe(2);
    expect(keyValues(res.body)).not.toContain('agent-b');
  });

  test("a tenant admin counts every project's spend", async () => {
    const h = harness({ authz });
    const res = await h.aggregate(ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.totalUsd).toBe(7.5);
    expect(keyValues(res.body)).toEqual(expect.arrayContaining(['agent-a', 'agent-b', 'agent-t']));
    expect(h.inputs.at(-1)?.readableProjectIds).toBeUndefined();
  });

  test("an admin's API key limited to project A counts only A (and the tenant's own records)", async () => {
    const h = harness({ authz });
    const res = await h.aggregate(ADMIN_KEY_A);
    expect(res.status).toBe(200);
    expect(res.body.totalUsd).toBe(2.5);
    expect(keyValues(res.body)).not.toContain('agent-b');
    expect(h.inputs.at(-1)?.readableProjectIds).toEqual([projectA]);
  });

  test('a project scope is checked as before, and not narrowed further', async () => {
    const h = harness({ authz });
    expect((await h.aggregate(MEMBER, `&scopeKind=project&scopeId=${projectB}`)).status).toBe(403);
    const res = await h.aggregate(MEMBER, `&scopeKind=project&scopeId=${projectA}`);
    expect(res.status).toBe(200);
    expect(res.body.totalUsd).toBe(2);
    expect(h.inputs.at(-1)?.readableProjectIds).toBeUndefined();
  });

  test("a binding that can't limit the aggregate refuses a member, and still answers an admin", async () => {
    const h = harness({ authz, appliesReadable: false });
    const member = await h.aggregate(MEMBER);
    expect(member.status).toBe(403);
    expect(member.body.error.code).toBe('permission-denied');
    expect(member.body.error.message).toMatch(
      /can't limit an aggregate to the projects you may read/,
    );
    expect((await h.aggregate(ADMIN)).status).toBe(200);
  });
});

test("without a list or a project binding to check, a member's aggregate across projects is refused", async () => {
  const h = harness({ authz: checkOnly, withProjects: false });
  const res = await h.aggregate(MEMBER);
  expect(res.status).toBe(403);
  expect(res.body.error.message).toMatch(/the projects you may read can't be listed here/);
});
