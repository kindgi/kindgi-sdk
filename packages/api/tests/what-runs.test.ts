// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `whatRuns`: the pin that covers a scope, else Latest for its project (a
 * segment's is its project's; with no project, the agent's Latest over
 * every project). `null` when neither has a version. And
 * `projectsPinTakesOffLatest`: the projects inside a pin's scope that
 * follow Latest now.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type {
  AgentPinScope,
  OrgId,
  ProjectId,
  ScopeSegment,
  Semver,
  TenantId,
} from '@kindgi/types';

import { type AgentPinResolution, type LatestBinding, whatRuns } from '../src/index.js';
import { projectsPinTakesOffLatest } from '../src/what-runs.js';

const tenantId = randomUUID() as TenantId;
const PROD = randomUUID() as ProjectId;
const agentId = 'acme.desk';

/** A pin that `resolve` answers (or none), and Latest that records each question. */
function agentPinsOf(pinned: AgentPinResolution | null, latest: Semver | null) {
  const asked: unknown[] = [];
  return {
    asked,
    agentPins: {
      pinned: {
        resolve: async () => pinned,
        list: async () => [],
      },
      latest: {
        async latest(q) {
          asked.push(q);
          return latest === null ? null : { version: latest, deploymentId: 'dep-1' };
        },
        byProject: async () => [],
      } satisfies LatestBinding,
    },
  };
}

describe('whatRuns', () => {
  test('a pin that covers the scope wins, and Latest is not asked', async () => {
    const pin: AgentPinResolution = {
      version: '1.0.0' as Semver,
      scope: { kind: 'project', projectId: PROD },
    };
    const { agentPins: r, asked } = agentPinsOf(pin, '2.0.0' as Semver);
    expect(await whatRuns(r, { tenantId, agentId, projectId: PROD })).toEqual({
      follows: 'pin',
      version: '1.0.0',
      pinnedScope: { kind: 'project', projectId: PROD },
    });
    expect(asked).toEqual([]);
  });

  test("no pin: Latest for the scope's project, a segment's included", async () => {
    const { agentPins: r, asked } = agentPinsOf(null, '2.0.0' as Semver);
    const segments = [{ key: 'region', value: 'eu' }];
    expect(await whatRuns(r, { tenantId, agentId, projectId: PROD, segments })).toEqual({
      follows: 'latest',
      version: '2.0.0',
      deploymentId: 'dep-1',
    });
    expect(asked).toEqual([{ tenantId, agentId, projectId: PROD }]);
  });

  test('no project (a tenant scope): Latest over every project', async () => {
    const { agentPins: r, asked } = agentPinsOf(null, '2.0.0' as Semver);
    await whatRuns(r, { tenantId, agentId });
    expect(asked).toEqual([{ tenantId, agentId }]);
  });

  test('no pin and no Latest: null', async () => {
    const { agentPins: r } = agentPinsOf(null, null);
    expect(await whatRuns(r, { tenantId, agentId, projectId: PROD })).toBeNull();
  });
});

describe('projectsPinTakesOffLatest', () => {
  const ORG = randomUUID() as OrgId;
  const OTHER_ORG = randomUUID() as OrgId;
  // Sorted, so the answer's order (by project id) reads as the list's.
  const [A, B, C] = [randomUUID(), randomUUID(), randomUUID()].sort() as [
    ProjectId,
    ProjectId,
    ProjectId,
  ];
  const orgOf = new Map<ProjectId, OrgId>([
    [A, ORG],
    [B, ORG],
    [C, OTHER_ORG],
  ]);
  const EU: ScopeSegment[] = [{ key: 'region', value: 'eu' }];
  const EU_GOLD: ScopeSegment[] = [...EU, { key: 'tier', value: 'gold' }];

  /**
   * Pins that resolve as a run's version does (the longest segment path
   * that starts the run's, then its project, its org, the tenant), and a
   * Latest in each of A, B and C.
   */
  function agentPinsWith(pins: readonly AgentPinScope[]) {
    const covers = (pin: AgentPinScope, projectId?: ProjectId, path?: readonly ScopeSegment[]) => {
      switch (pin.kind) {
        case 'tenant':
          return true;
        case 'org':
          return projectId !== undefined && orgOf.get(projectId) === pin.orgId;
        case 'project':
          return pin.projectId === projectId;
        case 'segment':
          return (
            pin.projectId === projectId &&
            path !== undefined &&
            pin.path.every((s, i) => s.key === path[i]?.key && s.value === path[i]?.value)
          );
      }
    };
    const rank = { segment: 3, project: 2, org: 1, tenant: 0 } as const;
    return {
      pinned: {
        resolve: async (q: { projectId?: ProjectId; segments?: readonly ScopeSegment[] }) => {
          const pin = [...pins]
            .filter((p) => covers(p, q.projectId, q.segments))
            .sort((x, y) => rank[y.kind] - rank[x.kind])[0];
          return pin === undefined ? null : { version: '1.0.0' as Semver, scope: pin };
        },
        list: async () => [],
      },
      latest: {
        latest: async ({ projectId }) =>
          projectId === undefined ? null : { version: '2.0.0' as Semver, deploymentId: 'dep-1' },
        byProject: async () =>
          [C, A, B].map((projectId) => ({ projectId, version: '2.0.0' as Semver })),
      } satisfies LatestBinding,
    };
  }
  const projects = {
    get: async (_tenant: TenantId, id: ProjectId) =>
      orgOf.has(id) ? ({ id, orgId: orgOf.get(id) } as never) : undefined,
  };
  const off = (pins: readonly AgentPinScope[], scope: AgentPinScope, withProjects = true) =>
    projectsPinTakesOffLatest(agentPinsWith(pins), withProjects ? projects : undefined, {
      tenantId,
      agentId,
      scope,
    });
  const onLatest = (...ids: ProjectId[]) =>
    ids.map((projectId) => ({ projectId, version: '2.0.0' }));

  test('a project pin: its project, when it follows Latest now, whatever version the pin names', async () => {
    expect(await off([], { kind: 'project', projectId: A })).toEqual(onLatest(A));
    expect(await off([{ kind: 'org', orgId: ORG }], { kind: 'project', projectId: A })).toEqual([]);
  });

  test("a segment pin: its project, when the segment's path follows Latest; a pin that covers the path leaves it out", async () => {
    expect(await off([], { kind: 'segment', projectId: A, path: EU_GOLD })).toEqual(onLatest(A));
    // A shorter path's pin covers it, and so does the project's.
    for (const pin of [
      { kind: 'segment', projectId: A, path: EU },
      { kind: 'project', projectId: A },
    ] satisfies AgentPinScope[]) {
      expect(await off([pin], { kind: 'segment', projectId: A, path: EU_GOLD })).toEqual([]);
    }
    // Another segment's pin doesn't: the project follows Latest there.
    expect(
      await off([{ kind: 'segment', projectId: A, path: EU_GOLD }], {
        kind: 'segment',
        projectId: A,
        path: [{ key: 'region', value: 'us' }],
      }),
    ).toEqual(onLatest(A));
  });

  test('a tenant pin: each project with a Latest that no pin covers, by project id', async () => {
    expect(await off([], { kind: 'tenant' })).toEqual(onLatest(A, B, C));
    expect(
      await off(
        [
          { kind: 'project', projectId: B },
          { kind: 'org', orgId: OTHER_ORG },
        ],
        {
          kind: 'tenant',
        },
      ),
    ).toEqual(onLatest(A));
    // A segment pin leaves its project on Latest everywhere else.
    expect(await off([{ kind: 'segment', projectId: A, path: EU }], { kind: 'tenant' })).toEqual(
      onLatest(A, B, C),
    );
  });

  test("an org pin: the org's projects on Latest only; without the project binding, none", async () => {
    expect(await off([], { kind: 'org', orgId: ORG })).toEqual(onLatest(A, B));
    expect(await off([{ kind: 'project', projectId: A }], { kind: 'org', orgId: ORG })).toEqual(
      onLatest(B),
    );
    expect(await off([], { kind: 'org', orgId: ORG }, false)).toEqual([]);
  });
});
