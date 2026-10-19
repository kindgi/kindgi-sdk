// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/usage`, a tenant's own usage. A tenant admin, and a deployment
 * without authorization, read every project and the tenant's records with
 * none; anyone else reads only the projects they may read, applied in the
 * binding's query (`projectIds`), and no record without a project. A
 * project they can't read is absent, never an error. Both ways of working
 * out the projects: the authorizer's list (`listObjects`), and each
 * project checked.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { Project, ProjectBinding } from '@kindgi/platform';
import type { ProjectId, TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  RunHandlerBinding,
  TokenResolver,
  UsageBinding,
  UsageGroup,
  UsageQuery,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const projectA = randomUUID() as ProjectId;
const projectB = randomUUID() as ProjectId;

const MEMBER = 'member-token';
const ADMIN = 'admin-token';
/** The admin's API key, limited to project A. */
const ADMIN_KEY_A = 'admin-key-for-a';
/** A member who may read no project. */
const NOBODY = 'nobody-token';

const resolveToken: TokenResolver = async (token) => {
  if (token === MEMBER) return { tenantId, userId: 'member-1' as UserId };
  if (token === ADMIN) return { tenantId, userId: 'admin-1' as UserId };
  if (token === ADMIN_KEY_A)
    return { tenantId, userId: 'admin-1' as UserId, tokenProjectId: projectA };
  if (token === NOBODY) return { tenantId, userId: 'nobody-1' as UserId };
  return null;
};

/** `action type:id` pairs each principal holds. */
const GRANTS: Readonly<Record<string, readonly string[]>> = {
  'member-1': [`read tenant:${tenantId}`, `read project:${projectA}`],
  'admin-1': [
    `admin tenant:${tenantId}`,
    `read tenant:${tenantId}`,
    `read project:${projectA}`,
    `read project:${projectB}`,
  ],
  'nobody-1': [`read tenant:${tenantId}`],
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
  readonly agentId?: string;
  readonly kind: UsageGroup['kind'] & string;
  readonly at: string;
}

/** Two runs in A, one in B, and one with no project (a project put in production is in its project; this one is the tenant's). */
const RECORDS: readonly Rec[] = [
  { projectId: projectA, agentId: 'agent-a', kind: 'run.started', at: '2026-11-02T10:00:00.000Z' },
  { projectId: projectA, agentId: 'agent-a', kind: 'run.started', at: '2026-11-03T10:00:00.000Z' },
  { projectId: projectB, agentId: 'agent-b', kind: 'run.started', at: '2026-11-04T10:00:00.000Z' },
  { kind: 'llm.embedding', at: '2026-11-05T10:00:00.000Z' },
];

const WATERMARK = '2026-11-06T00:00:00.000Z';

/** A record's group key, for the dimensions this fake knows. */
function groupKey(r: Rec, groupBy: UsageQuery['groupBy']): Record<string, string> {
  const key: Record<string, string> = {};
  for (const d of groupBy) {
    if (d === 'project' && r.projectId !== undefined) key.projectId = r.projectId;
    if (d === 'agent' && r.agentId !== undefined) key.agentId = r.agentId;
    if (d === 'kind') key.kind = r.kind;
  }
  return key;
}

/** `RECORDS` grouped as the runtime's query groups them, over `projectIds` when given. */
function grouped(query: UsageQuery): UsageGroup[] {
  const { projectIds } = query;
  const counted = RECORDS.filter(
    (r) =>
      projectIds === undefined || (r.projectId !== undefined && projectIds.includes(r.projectId)),
  );
  const groups = new Map<string, UsageGroup>();
  for (const r of counted) {
    const key = groupKey(r, query.groupBy);
    const id = JSON.stringify(key);
    const g = groups.get(id);
    groups.set(id, {
      ...key,
      count: (g?.count ?? 0) + 1,
      quantity: (g?.quantity ?? 0) + 1,
      firstAt: g?.firstAt ?? r.at,
      lastAt: r.at,
    });
  }
  return [...groups.values()];
}

/** A binding that answers with `grouped`, and keeps each read. */
function usageBinding(): { binding: UsageBinding; reads: UsageQuery[] } {
  const reads: UsageQuery[] = [];
  const binding: UsageBinding = {
    acrossTenants: async () => {
      throw new Error('not used: a tenant route');
    },
    ofTenant: async (asked, query) => {
      expect(asked).toBe(tenantId);
      reads.push(query);
      if (query.cursor === 'forged') return { kind: 'cursor-unreadable' };
      return { kind: 'ok', page: { data: grouped(query), watermark: WATERMARK } };
    },
  };
  return { binding, reads };
}

function harness(opts: {
  readonly authz?: AuthzCheckBinding;
  readonly withProjects?: boolean;
}) {
  const { binding, reads } = usageBinding();
  const projectBinding = {
    list: async () => ({
      items: [projectA, projectB].map((id) => ({ id, tenantId })) as unknown as Project[],
    }),
  } as unknown as ProjectBinding;
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    usage: binding,
    ...(opts.withProjects !== false && { projectBinding }),
    ...(opts.authz !== undefined && {
      authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding: opts.authz },
    }),
  });
  /** A read of November 2026, with `query` added. */
  const read = (token: string, query = '') =>
    readRaw(token, `from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z${query}`);
  const readRaw = async (token: string, query: string) => {
    const res = await app.request(`/v1/usage?${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { read, readRaw, reads };
}

/** Every agent and project any group names. */
function named(body: Record<string, any>): string[] {
  return (body.data as UsageGroup[]).flatMap((g) =>
    [g.projectId, g.agentId].filter((v): v is string => v !== undefined),
  );
}

function total(body: Record<string, any>): number {
  return (body.data as UsageGroup[]).reduce((sum, g) => sum + g.count, 0);
}

describe.each([
  ['the authorizer lists the projects', withList],
  ['each project is checked', checkOnly],
])('GET /v1/usage, when %s', (_, authz) => {
  test("a tenant admin reads every project, and the tenant's records with none", async () => {
    const h = harness({ authz });
    const res = await h.read(ADMIN, '&groupBy=project,agent,kind');
    expect(res.status).toBe(200);
    expect(total(res.body)).toBe(4);
    expect(named(res.body)).toEqual(expect.arrayContaining([projectA, projectB, 'agent-b']));
    expect(res.body.watermark).toBe(WATERMARK);
    expect(h.reads.at(-1)?.projectIds).toBeUndefined();
  });

  test("a member reads only the projects they may read: no other project's agent, and no record without a project", async () => {
    const h = harness({ authz });
    const res = await h.read(MEMBER, '&groupBy=project,agent,kind');
    expect(res.status).toBe(200);
    expect(total(res.body)).toBe(2);
    expect(named(res.body)).not.toContain(projectB);
    expect(named(res.body)).not.toContain('agent-b');
    expect((res.body.data as UsageGroup[]).map((g) => g.kind)).not.toContain('llm.embedding');
    expect(h.reads.at(-1)?.projectIds).toEqual([projectA]);
  });

  test("an admin's API key limited to project A reads only A, and not the tenant's records; naming B is refused", async () => {
    const h = harness({ authz });
    const res = await h.read(ADMIN_KEY_A, '&groupBy=project,agent');
    expect(res.status).toBe(200);
    expect(total(res.body)).toBe(2);
    expect(named(res.body)).not.toContain('agent-b');
    expect(h.reads.at(-1)?.projectIds).toEqual([projectA]);
    // Naming another project is refused, as on every route (`key-project.ts`).
    const b = await h.read(ADMIN_KEY_A, `&projectId=${projectB}`);
    expect([b.status, b.body.error.code]).toEqual([403, 'key-project-mismatch']);
    expect(h.reads).toHaveLength(1);
  });

  test("one project asked for with projectId: read when the caller may, empty when they can't (never an error)", async () => {
    const h = harness({ authz });
    const a = await h.read(MEMBER, `&projectId=${projectA.toUpperCase()}`);
    expect(a.status).toBe(200);
    expect(total(a.body)).toBe(2);
    expect(h.reads.at(-1)?.projectIds).toEqual([projectA]);
    const b = await h.read(MEMBER, `&projectId=${projectB}`);
    expect([b.status, b.body.data]).toEqual([200, []]);
    expect(h.reads.at(-1)?.projectIds).toEqual([]);
    const unknown = await h.read(MEMBER, `&projectId=${randomUUID()}`);
    expect([unknown.status, unknown.body.data]).toEqual([200, []]);
  });

  test('a tenant admin asking for one project reads that one only', async () => {
    const h = harness({ authz });
    const res = await h.read(ADMIN, `&projectId=${projectB}`);
    expect(res.status).toBe(200);
    expect(total(res.body)).toBe(1);
    expect(h.reads.at(-1)?.projectIds).toEqual([projectB]);
  });

  test('a member who may read no project reads nothing', async () => {
    const h = harness({ authz });
    const res = await h.read(NOBODY);
    expect([res.status, res.body.data]).toEqual([200, []]);
    expect(h.reads.at(-1)?.projectIds).toEqual([]);
  });
});

describe('GET /v1/usage', () => {
  test("without a list or a project binding to check, a member's read across projects is refused; one project is still checked", async () => {
    const h = harness({ authz: checkOnly, withProjects: false });
    const res = await h.read(MEMBER);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('permission-denied');
    expect(res.body.error.message).toMatch(/^The projects you may read can't be listed here/);
    expect(h.reads).toEqual([]);
    const a = await h.read(MEMBER, `&projectId=${projectA}`);
    expect(a.status).toBe(200);
    expect(h.reads.at(-1)?.projectIds).toEqual([projectA]);
    expect((await h.read(ADMIN)).status).toBe(200);
  });

  test('without authorization, every project is read', async () => {
    const h = harness({});
    const res = await h.read(MEMBER);
    expect(res.status).toBe(200);
    expect(total(res.body)).toBe(4);
    expect(h.reads.at(-1)?.projectIds).toBeUndefined();
  });

  test('passes the query to the binding: defaults grouped by project and kind, 1000 groups a page', async () => {
    const h = harness({});
    await h.read(MEMBER);
    expect(h.reads.at(-1)).toEqual({
      from: new Date('2026-11-01T00:00:00Z'),
      to: new Date('2026-12-01T00:00:00Z'),
      groupBy: ['project', 'kind'],
      limit: 1000,
    });
    await h.read(
      MEMBER,
      '&groupBy=day,state&kind=run.ended&class=production&state=failed,cancelled&limit=10&cursor=c1',
    );
    expect(h.reads.at(-1)).toEqual({
      from: new Date('2026-11-01T00:00:00Z'),
      to: new Date('2026-12-01T00:00:00Z'),
      groupBy: ['day', 'state'],
      kinds: ['run.ended'],
      classes: ['production'],
      states: ['failed', 'cancelled'],
      limit: 10,
      cursor: 'c1',
    });
  });

  test("a query it can't read is 400: no tenant grouping, no other tenant, a project id or nothing", async () => {
    const h = harness({ authz: withList });
    for (const q of [
      '&groupBy=tenant',
      '&groupBy=project,tenant',
      '&projectId=acme',
      '&kind=run.anything',
      '&limit=0',
    ]) {
      const res = await h.read(ADMIN, q);
      expect([res.status, res.body.error?.code], q).toEqual([400, 'bad-input']);
    }
    expect(h.reads).toEqual([]);
  });

  test('a tenantId query param is ignored: an admin reads its own tenant, never another', async () => {
    const h = harness({ authz: withList });
    // `tenantId` isn't a query the parser knows, so it's dropped and the read goes to
    // the caller's own tenant. The ofTenant mock asserts `asked === tenantId`, so a
    // route that read the tenant from the query would ask for the foreign one and 500.
    const res = await h.read(ADMIN, `&tenantId=${randomUUID()}`);
    expect(res.status).toBe(200);
    expect(h.reads).toHaveLength(1);
  });

  test('a window of 92 days is read; a longer one, or none, is 400 before any project is worked out', async () => {
    const h = harness({ authz: checkOnly, withProjects: false });
    const ok = await h.readRaw(ADMIN, 'from=2026-01-01T00:00:00Z&to=2026-04-03T00:00:00Z');
    expect(ok.status).toBe(200);
    for (const q of [
      'from=2026-01-01T00:00:00Z&to=2026-04-03T00:00:00.001Z',
      'from=2026-11-01T00:00:00Z',
      '',
    ]) {
      // A member here would be refused (403) once projects were worked out.
      const res = await h.readRaw(MEMBER, q);
      expect([res.status, res.body.error?.code], q).toEqual([400, 'bad-input']);
    }
    expect(h.reads).toHaveLength(1);
  });

  test("a cursor the binding can't read is 400: start again", async () => {
    const h = harness({ authz: withList });
    const res = await h.read(ADMIN, '&cursor=forged');
    expect([res.status, res.body.error.code]).toEqual([400, 'bad-input']);
    expect(res.body.error.message).toContain('start again');
  });
});
