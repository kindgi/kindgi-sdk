// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/agents/:agentId/projects` reads each pin change once, however
 * many projects its pin covers, and builds the rows a few at a time: at
 * most four at once, in the projects' order. A failure answers as building
 * them one after another does. The agent runs in six projects, P1 to P6,
 * all of them read by the caller, with 1.0.0 in each. A pin change's read
 * waits a moment, so reads that run together overlap.
 */

import { randomUUID } from 'node:crypto';

import { HTTPException } from 'hono/http-exception';
import { describe, expect, test } from 'vitest';

import type { AgentPinScope, ProjectId, Semver, TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  AgentPinBindings,
  AgentPinResolveInput,
  AgentPinnedVersion,
  CreateAppInput,
  LatestInProject,
  TokenResolver,
} from '../src/index.js';
import { environmentOrders } from './support/environment-orders.js';
import { type Grant, grantsAuthz, itemProjects } from './support/order-items.js';

const tenantId = randomUUID() as TenantId;
const PROJECTS = [1, 2, 3, 4, 5, 6].map(() => randomUUID() as ProjectId);
const STAGING = randomUUID() as ProjectId;
const QA = randomUUID() as ProjectId;
const DESK = 'acme.desk';
const SET_AT = '2026-11-07T09:00:00.000Z';
const SIX = [1, 2, 3, 4, 5, 6];

/** The agent's nth project, from 1. */
const project = (n: number) => PROJECTS[n - 1] as ProjectId;

const resolveToken: TokenResolver = async (token) =>
  token === 'reader' ? { tenantId, userId: token as UserId } : null;

const pin = (scope: AgentPinScope, changeId: string): AgentPinnedVersion => ({
  agentId: DESK,
  scope,
  version: '1.0.0' as Semver,
  changeId,
  setAt: SET_AT as AgentPinnedVersion['setAt'],
});

/** The nth project's own pin, set by the pin change `pin-p<n>`. */
const projectPin = (n: number) => pin({ kind: 'project', projectId: project(n) }, `pin-p${n}`);
const TENANT_PIN = pin({ kind: 'tenant' }, 'pin-tenant');

/** How a pin change's read goes. */
interface ChangeRead {
  /** How long it takes, in ms; 1 when absent. */
  readonly ms?: number;
  /** What it fails with, after `ms`. */
  readonly fails?: Error;
}

function harness(
  pins: readonly AgentPinnedVersion[],
  latest: readonly LatestInProject[],
  reads: Readonly<Record<string, ChangeRead>> = {},
) {
  const rank = { segment: 0, project: 1, org: 2, tenant: 3 } as const;
  const covers = (scope: AgentPinScope, q: AgentPinResolveInput) =>
    scope.kind === 'tenant' || (scope.kind === 'project' && scope.projectId === q.projectId);
  // The pin changes read, and how many reads were running at once: now,
  // and at the most.
  const changes = { asked: [] as string[], now: 0, most: 0 };
  const agentPins = {
    pinned: {
      async resolve(q: AgentPinResolveInput) {
        const found = pins
          .filter((p) => covers(p.scope, q))
          .sort((a, b) => rank[a.scope.kind] - rank[b.scope.kind])[0];
        return found === undefined ? null : { version: found.version, scope: found.scope };
      },
      async list() {
        return pins;
      },
    },
    latest: {
      async byProject() {
        return latest;
      },
    },
    changes: {
      async get(_tenantId: TenantId, id: string) {
        const read = reads[id];
        changes.asked.push(`change ${id}`);
        changes.now += 1;
        changes.most = Math.max(changes.most, changes.now);
        await new Promise((resolve) => setTimeout(resolve, read?.ms ?? 1));
        changes.now -= 1;
        if (read?.fails !== undefined) throw read.fails;
        return { id, requestedBy: { kind: 'user', id: `owner-of-${id}` } };
      },
    },
  } as unknown as AgentPinBindings;
  const authz = grantsAuthz(
    { reader: PROJECTS.map((p): Grant => `read project:${p}`) },
    { [`agent:${DESK}`]: project(1) },
  );
  const app = createApp({
    ...createStubAppBindings(),
    agentRegistry: {
      // The highest active version, which numbers the next one.
      async get() {
        return { id: DESK, version: '1.0.0', tenantId, projectId: project(1) };
      },
    },
    agentPins,
    resolveToken,
    authz: authz.authz,
    itemProjects: itemProjects([
      {
        kind: 'agent',
        id: DESK,
        projects: PROJECTS,
        versions: [{ version: '1.0.0', projects: PROJECTS }],
      },
    ]),
    environmentOrders: environmentOrders([[STAGING, QA]]),
  } as unknown as CreateAppInput);
  const projects = async () => {
    const res = await app.request(`/v1/agents/${DESK}/projects`, {
      headers: { authorization: 'Bearer reader', 'x-request-id': 'req-agent-projects-together' },
    });
    // How many pin change reads were still running when the answer came.
    const running = changes.now;
    return { status: res.status, running, text: await res.text() };
  };
  return { projects, changes };
}

/** The rows of an answer. */
const rowsOf = (res: { readonly text: string }) => (JSON.parse(res.text) as { data: unknown }).data;

/** The row of the nth project when a pin runs 1.0.0 there, set by `changeId`. */
const pinnedRow = (n: number, pinnedScope: Record<string, unknown>, changeId: string) => ({
  projectId: project(n),
  follows: 'pin',
  runs: {
    version: '1.0.0',
    pinnedScope,
    since: SET_AT,
    pinChangeId: changeId,
    by: { kind: 'user', id: `owner-of-${changeId}` },
  },
});

/** The row of the nth project under its own pin. */
const ownPinRow = (n: number) =>
  pinnedRow(n, { kind: 'project', projectId: project(n) }, `pin-p${n}`);

/** The row of the nth project under the tenant pin. */
const tenantPinRow = (n: number) => pinnedRow(n, { kind: 'tenant' }, 'pin-tenant');

/** The nth project's Latest, 1.0.0, and the row it gives. */
const latestIn = (n: number): LatestInProject => ({
  projectId: project(n),
  version: '1.0.0' as Semver,
});
const latestRow = (n: number) => ({
  projectId: project(n),
  follows: 'latest',
  runs: { version: '1.0.0' },
});

describe('GET /v1/agents/:agentId/projects reads its pin changes once, a few at a time', () => {
  test("two pinned projects are read together, and their rows keep the projects' order", async () => {
    // P1's read ends last: read one after another, the two never overlap.
    // P3 to P6 follow Latest, which reads no pin change.
    const { projects, changes } = harness(
      [projectPin(1), projectPin(2)],
      [3, 4, 5, 6].map(latestIn),
      {
        'pin-p1': { ms: 20 },
      },
    );
    const res = await projects();
    expect(res.status, res.text).toBe(200);
    expect(changes.most).toBe(2);
    expect(changes.asked).toEqual(['change pin-p1', 'change pin-p2']);
    expect(rowsOf(res)).toEqual([ownPinRow(1), ownPinRow(2), ...[3, 4, 5, 6].map(latestRow)]);
  });

  test('six pinned projects: at most four pin changes are read at once, and every row comes back in order', async () => {
    const reads = Object.fromEntries(SIX.map((n) => [`pin-p${n}`, { ms: 20 }]));
    const { projects, changes } = harness(SIX.map(projectPin), [], reads);
    const res = await projects();
    expect(res.status, res.text).toBe(200);
    expect(changes.most).toBe(4);
    expect(rowsOf(res)).toEqual(SIX.map(ownPinRow));
  });

  test('a pin change that covers several projects is read once a request', async () => {
    // The tenant pin covers all six projects.
    const tenant = harness([TENANT_PIN], []);
    const one = await tenant.projects();
    expect(one.status, one.text).toBe(200);
    expect(tenant.changes.asked).toEqual(['change pin-tenant']);
    expect(rowsOf(one)).toEqual(SIX.map(tenantPinRow));
    // A second request reads it again: once a request, not once for good.
    const again = await tenant.projects();
    expect(again.status, again.text).toBe(200);
    expect(tenant.changes.asked).toEqual(['change pin-tenant', 'change pin-tenant']);
    // With pins of their own on P2 and P5 too, each of the three is read once.
    const mixed = harness([TENANT_PIN, projectPin(2), projectPin(5)], []);
    const two = await mixed.projects();
    expect(two.status, two.text).toBe(200);
    expect([...mixed.changes.asked].sort()).toEqual([
      'change pin-p2',
      'change pin-p5',
      'change pin-tenant',
    ]);
    expect(rowsOf(two)).toEqual(
      SIX.map((n) => (n === 2 || n === 5 ? ownPinRow(n) : tenantPinRow(n))),
    );
  });

  test("a failure answers as one after another does: the earliest project's, once the running reads end, and no more start", async () => {
    // P2's read fails first. P1's fails after it, with an answer of its
    // own, and that's the one reading in turn gives.
    const { projects, changes } = harness(SIX.map(projectPin), [], {
      'pin-p1': { ms: 20, fails: new HTTPException(409, { message: 'the first project' }) },
      'pin-p2': { fails: new Error('the second project') },
      'pin-p3': { ms: 20 },
      'pin-p4': { ms: 20 },
      'pin-p5': { ms: 20 },
      'pin-p6': { ms: 20 },
    });
    const res = await projects();
    expect(res.status, res.text).toBe(409);
    expect(res.running).toBe(0);
    expect(changes.most).toBe(4);
    expect(changes.asked).not.toContain('change pin-p5');
    expect(changes.asked).not.toContain('change pin-p6');
  });
});
