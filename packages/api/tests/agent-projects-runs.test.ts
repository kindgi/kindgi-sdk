// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/agents/:agentId/projects` with pins and Latest wired: each
 * project says what a run there that names no version gets (`runs`) and
 * why (`follows`), with the pins on segments inside it, and the answer
 * gives the agent's highest version. An environment order carries
 * `acme.desk` from staging to prod. Prod is pinned to 1.0.0 and its EU
 * segment to 1.1.0; staging follows its Latest, 1.1.0 by a deployment.
 * 1.2.0, the highest, was made in staging only, so a caller who reads
 * prod alone can't see it.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { LiveScope, ProjectId, Semver, TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  AgentReleaseBindings,
  CreateAppInput,
  LatestInProject,
  LivePin,
  LiveResolveInput,
  TokenResolver,
} from '../src/index.js';
import { environmentOrders } from './support/environment-orders.js';
import { type Grant, type ItemRow, grantsAuthz, itemProjects } from './support/order-items.js';

const tenantId = randomUUID() as TenantId;
const STAGING = randomUUID() as ProjectId;
const PROD = randomUUID() as ProjectId;

const DESK = 'acme.desk';
const EU = [{ key: 'region', value: 'eu' }];

const ROWS: ItemRow[] = [
  {
    kind: 'agent',
    id: DESK,
    projects: [STAGING, PROD],
    versions: [
      { version: '1.0.0', projects: [STAGING, PROD] },
      { version: '1.1.0', projects: [STAGING, PROD] },
      { version: '1.2.0', projects: [STAGING] },
    ],
  },
];

const PEOPLE: Record<string, readonly Grant[]> = {
  both: [`read project:${STAGING}`, `read project:${PROD}`],
  prod: [`read project:${PROD}`],
};

const resolveToken: TokenResolver = async (token) =>
  token in PEOPLE ? { tenantId, userId: token as UserId } : null;

const pin = (scope: LiveScope, version: string, promotionId: string): LivePin => ({
  agentId: DESK,
  scope,
  version: version as Semver,
  promotionId,
  setAt: '2026-10-20T09:00:00.000Z' as LivePin['setAt'],
});

const PROD_PIN = pin({ kind: 'project', projectId: PROD }, '1.0.0', 'promo-prod');
const EU_PIN = pin({ kind: 'segment', projectId: PROD, path: EU }, '1.1.0', 'promo-eu');

const STAGING_LATEST: LatestInProject = {
  projectId: STAGING,
  version: '1.1.0' as Semver,
  since: '2026-10-25T12:00:00.000Z',
  deploymentId: 'dep-staging',
};

/**
 * Pins and Latest over fixed rows: `resolve` answers the most specific
 * pin covering the scope (segment, project, tenant). `asked` names each
 * read, so a test can count them.
 */
function releasesOf(pins: readonly LivePin[], latest: readonly LatestInProject[]) {
  const asked: string[] = [];
  const covers = (scope: LiveScope, q: LiveResolveInput) => {
    switch (scope.kind) {
      case 'tenant':
        return true;
      case 'project':
        return scope.projectId === q.projectId;
      case 'segment':
        return (
          scope.projectId === q.projectId &&
          JSON.stringify(scope.path) === JSON.stringify(q.segments ?? [])
        );
      default:
        return false;
    }
  };
  const rank = { segment: 0, project: 1, org: 2, tenant: 3 } as const;
  const releases = {
    live: {
      async resolve(q: LiveResolveInput) {
        asked.push(`resolve ${q.projectId ?? 'none'}`);
        const found = pins
          .filter((p) => covers(p.scope, q))
          .sort((a, b) => rank[a.scope.kind] - rank[b.scope.kind])[0];
        return found === undefined ? null : { version: found.version, scope: found.scope };
      },
      async list() {
        asked.push('list');
        return pins;
      },
    },
    latest: {
      async latest() {
        throw new Error('the route reads every project at once (byProject)');
      },
      async byProject() {
        asked.push('byProject');
        return latest;
      },
    },
    promotions: {
      async get(_tenantId: TenantId, id: string) {
        asked.push(`promotion ${id}`);
        return { id, requestedBy: { kind: 'user', id: `owner-of-${id}` } };
      },
    },
  };
  return { releases: releases as unknown as AgentReleaseBindings, asked };
}

function harness(pins: readonly LivePin[], latest: readonly LatestInProject[]) {
  const { releases, asked } = releasesOf(pins, latest);
  const authz = grantsAuthz(PEOPLE, { [`agent:${DESK}`]: STAGING });
  const app = createApp({
    ...createStubAppBindings(),
    agentRegistry: {
      // The highest active version, which numbers the next one.
      async get() {
        return { id: DESK, version: '1.2.0', tenantId, projectId: STAGING };
      },
    },
    agentReleases: releases,
    resolveToken,
    authz: authz.authz,
    itemProjects: itemProjects(ROWS),
    environmentOrders: environmentOrders([[STAGING, PROD]]),
  } as unknown as CreateAppInput);
  const projects = async (who: string) => {
    const res = await app.request(`/v1/agents/${DESK}/projects`, {
      headers: { authorization: `Bearer ${who}`, 'x-request-id': 'req-agent-projects-runs' },
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    return JSON.parse(text) as Record<string, unknown>;
  };
  return { projects, asked };
}

describe('GET /v1/agents/:agentId/projects: what runs in each project', () => {
  test('a pin wins in its project, Latest runs where none covers it, and the highest numbers the next', async () => {
    const { projects, asked } = harness([PROD_PIN, EU_PIN], [STAGING_LATEST]);
    expect(await projects('both')).toEqual({
      data: [
        {
          projectId: STAGING,
          follows: 'latest',
          runs: {
            version: '1.1.0',
            since: '2026-10-25T12:00:00.000Z',
            deploymentId: 'dep-staging',
          },
        },
        {
          projectId: PROD,
          follows: 'pin',
          runs: {
            version: '1.0.0',
            liveScope: { kind: 'project', projectId: PROD },
            since: '2026-10-20T09:00:00.000Z',
            promotionId: 'promo-prod',
            by: { kind: 'user', id: 'owner-of-promo-prod' },
          },
          segments: [{ path: EU, version: '1.1.0' }],
        },
      ],
      highest: { version: '1.2.0' },
    });
    // One read of the pins and one of Latest everywhere, then a pin lookup per project.
    expect(asked.filter((a) => a === 'list' || a === 'byProject').sort()).toEqual([
      'byProject',
      'list',
    ]);
    expect(asked.filter((a) => a.startsWith('resolve'))).toEqual([
      `resolve ${STAGING}`,
      `resolve ${PROD}`,
    ]);
  });

  test("Latest made by a person's publish names who, and no deployment", async () => {
    const byAna: LatestInProject = {
      projectId: STAGING,
      version: '1.0.0' as Semver,
      since: '2026-10-26T08:00:00.000Z',
      by: { kind: 'user', id: 'ana' },
    };
    const { projects } = harness([], [byAna]);
    const body = await projects('both');
    expect((body.data as unknown[])[0]).toEqual({
      projectId: STAGING,
      follows: 'latest',
      runs: {
        version: '1.0.0',
        since: '2026-10-26T08:00:00.000Z',
        by: { kind: 'user', id: 'ana' },
      },
    });
  });

  test('a pin above the project (the tenant) covers it, and is named as such', async () => {
    const tenantPin = pin({ kind: 'tenant' }, '1.0.0', 'promo-tenant');
    const { projects } = harness([tenantPin], [STAGING_LATEST]);
    const body = await projects('both');
    for (const row of body.data as { follows: string; runs: Record<string, unknown> }[]) {
      expect(row.follows).toBe('pin');
      expect(row.runs).toEqual({
        version: '1.0.0',
        liveScope: { kind: 'tenant' },
        since: '2026-10-20T09:00:00.000Z',
        promotionId: 'promo-tenant',
        by: { kind: 'user', id: 'owner-of-promo-tenant' },
      });
    }
  });

  test('a project with no pin and no Latest: the project alone', async () => {
    const { projects } = harness([], []);
    expect(await projects('both')).toEqual({
      data: [{ projectId: STAGING }, { projectId: PROD }],
      highest: { version: '1.2.0' },
    });
  });

  test("a version the caller can't see is left out: a segment pin's, and the highest", async () => {
    const hiddenEu = pin({ kind: 'segment', projectId: PROD, path: EU }, '1.2.0', 'promo-eu');
    const { projects } = harness([PROD_PIN, hiddenEu], [STAGING_LATEST]);
    expect(await projects('prod')).toEqual({
      data: [
        {
          projectId: PROD,
          follows: 'pin',
          runs: {
            version: '1.0.0',
            liveScope: { kind: 'project', projectId: PROD },
            since: '2026-10-20T09:00:00.000Z',
            promotionId: 'promo-prod',
            by: { kind: 'user', id: 'owner-of-promo-prod' },
          },
        },
      ],
    });
  });

  test("when the caller can't see what runs, the project is named alone", async () => {
    const hiddenPin = pin({ kind: 'project', projectId: PROD }, '1.2.0', 'promo-prod');
    const { projects, asked } = harness([hiddenPin], []);
    expect(await projects('prod')).toEqual({ data: [{ projectId: PROD }] });
    // Nothing is said about the hidden pin, so its promotion isn't read.
    expect(asked.some((a) => a.startsWith('promotion'))).toBe(false);
  });
});
