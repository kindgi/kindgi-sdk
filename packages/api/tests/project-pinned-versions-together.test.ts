// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/projects/:projectId/pinned-versions` on a page of agents more
 * than one project serves: their projects are asked once for the page,
 * and their versions are read together, not one agent after another. The
 * answer is the same either way, in the page's order.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { ProjectBinding } from '@kindgi/platform';
import type { ProjectId, Semver, TenantId, Timestamp, UserId } from '@kindgi/types';

import { createStubAppBindings, createStubBinding } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  AgentPinBindings,
  AgentPinnedVersion,
  ItemProjectsBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';
import { noLatest } from './support/latest.js';
import { type Grant, grantsAuthz, itemProjects } from './support/order-items.js';

const tenantId = randomUUID() as TenantId;
const STAGING = randomUUID() as ProjectId;
const PROD = randomUUID() as ProjectId;
const NOW = '2026-11-07T00:00:00.000Z' as Timestamp;

/** Two agents staging and prod both serve. */
const DESK = 'acme.desk';
const RELAY = 'acme.relay';

/** The caller reads prod only. */
const resolveToken: TokenResolver = async (token) =>
  token === 'prod-reader' ? { tenantId, userId: token as UserId } : null;

const pin = (agentId: string, version: string): AgentPinnedVersion => ({
  agentId,
  scope: { kind: 'project', projectId: PROD },
  version: version as Semver,
  changeId: `p-${agentId}-${version}`,
  setAt: NOW,
});

/** The page: acme.desk's 1.1.0 runs in staging only, so prod's reader doesn't see it. */
const PAGE: readonly AgentPinnedVersion[] = [
  pin(DESK, '1.0.0'),
  pin(DESK, '1.1.0'),
  pin(RELAY, '2.0.0'),
];

function harness() {
  const table = itemProjects([
    {
      kind: 'agent',
      id: DESK,
      projects: [STAGING, PROD],
      versions: [
        { version: '1.0.0', projects: [STAGING, PROD] },
        { version: '1.1.0', projects: [STAGING] },
      ],
    },
    {
      kind: 'agent',
      id: RELAY,
      projects: [STAGING, PROD],
      versions: [{ version: '2.0.0', projects: [PROD] }],
    },
  ]);
  // Each agent's version read waits a moment, the page's first agent's
  // longest: reads one after another never overlap, and these end out of
  // the page's order.
  const reads = { now: 0, most: 0 };
  const items: ItemProjectsBinding = {
    ...table,
    async versionProjectsOfMany(input) {
      reads.now += 1;
      reads.most = Math.max(reads.most, reads.now);
      await new Promise((resolve) => setTimeout(resolve, input.id === DESK ? 20 : 1));
      reads.now -= 1;
      return table.versionProjectsOfMany(input);
    },
  };
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: createStubBinding<RunHandlerBinding>('runHandler', {
      invokeAgent: true,
      invokeFlow: true,
      resumeRun: true,
    }),
    agentPins: {
      pinned: {
        resolve: async () => null,
        list: async () => [],
        issuedCursor: () => false,
        listCovering: async () => ({ data: PAGE }),
      },
      latest: noLatest,
      changes: {} as AgentPinBindings['changes'],
    },
    projectBinding: {
      get: async (_tenant: TenantId, projectId: ProjectId) =>
        [STAGING, PROD].includes(projectId) ? { projectId, tenantId } : undefined,
    } as unknown as ProjectBinding,
    authz: grantsAuthz({ 'prod-reader': [`read project:${PROD}` as Grant] }).authz,
    itemProjects: items,
  });
  const list = async () => {
    const res = await app.request(`/v1/projects/${PROD}/pinned-versions`, {
      headers: { authorization: 'Bearer prod-reader' },
    });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as Record<string, any> };
  };
  return { list, reads, asked: table.asked };
}

const versions = (body: Record<string, any>) =>
  (body.data as { agentId: string; version: string }[]).map((p) => `${p.agentId}@${p.version}`);

describe('a page of pins on agents more than one project serves', () => {
  test("reads the agents' versions together, and answers in the page's order", async () => {
    const { list, reads } = harness();
    const res = await list();
    expect(res.status, res.text).toBe(200);
    expect(reads.most).toBe(2);
    expect(versions(res.body)).toEqual([`${DESK}@1.0.0`, `${RELAY}@2.0.0`]);
  });

  test("asks the agents' projects once for the page", async () => {
    const { list, asked } = harness();
    const res = await list();
    expect(res.status, res.text).toBe(200);
    expect(asked.filter((a) => a.startsWith('projectsOf'))).toEqual(['projectsOfMany agent']);
    expect(asked.filter((a) => a.startsWith('versionProjectsOfMany')).sort()).toEqual([
      `versionProjectsOfMany agent ${DESK}`,
      `versionProjectsOfMany agent ${RELAY}`,
    ]);
  });
});
