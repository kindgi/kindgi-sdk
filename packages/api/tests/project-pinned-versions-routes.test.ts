// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/projects/:projectId/pinned-versions`: every agent's pins that
 * cover a project, a page at a time. The binding is a fake that records
 * its input and answers what each test sets up: which pins cover a project
 * is the runtime's to test. Here: the guard on the project comes first,
 * paging is the promotions list's, a binding without `listCovering`
 * answers 501, and a caller sees a pin only with read on its agent and its
 * version, each pin at its own version.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { ProjectBinding } from '@kindgi/platform';
import type { Cursor, ProjectId, Semver, TenantId, Timestamp, UserId } from '@kindgi/types';

import { createStubAppBindings, createStubBinding } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  AgentReleaseBindings,
  ListCoveringPinsInput,
  LivePin,
  LiveVersionBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';
import { type Grant, type ItemRow, grantsAuthz, itemProjects } from './support/order-items.js';

const tenantId = randomUUID() as TenantId;
const STAGING = randomUUID() as ProjectId;
const PROD = randomUUID() as ProjectId;
const OTHER = randomUUID() as ProjectId;
const ORG = randomUUID();
const NOW = '2026-10-28T00:00:00.000Z' as Timestamp;

/** An agent an order carries from staging to prod, and one in a single project. */
const SERVED = 'acme.desk';
const SOLO = 'acme.solo';

/** `0.9.0` runs in prod only, `1.0.0` in both, `1.1.0` (the newest) in staging only. */
function rows(): ItemRow[] {
  return [
    {
      kind: 'agent',
      id: SERVED,
      projects: [STAGING, PROD],
      versions: [
        { version: '0.9.0', projects: [PROD] },
        { version: '1.0.0', projects: [STAGING, PROD] },
        { version: '1.1.0', projects: [STAGING] },
      ],
    },
    {
      kind: 'agent',
      id: SOLO,
      projects: [OTHER],
      versions: [{ version: '1.0.0', projects: [OTHER] }],
    },
  ];
}

const on = (project: ProjectId, ...actions: string[]) =>
  actions.map((a) => `${a} project:${project}` as Grant);

const PEOPLE: Record<string, readonly Grant[]> = {
  /** Reads prod only. */
  'prod-reader': on(PROD, 'read'),
  /** Reads staging and prod. */
  'staging-reader': [...on(STAGING, 'read'), ...on(PROD, 'read')],
  /** Reads prod, and the one-project agent itself: today's check of an agent is its own read. */
  'solo-reader': [...on(PROD, 'read'), `read agent:${SOLO}` as Grant],
};

const resolveToken: TokenResolver = async (token) =>
  token in PEOPLE || token === 'anyone' ? { tenantId, userId: token as UserId } : null;

const pin = (agentId: string, version: string, scope: LivePin['scope']): LivePin => ({
  agentId,
  scope,
  version: version as Semver,
  promotionId: `p-${agentId}-${version}`,
  setAt: NOW,
});

/** The pins that cover prod: the tenant's, the org's, prod's own and one of its segments'. */
const COVERING_PROD: readonly LivePin[] = [
  pin(SERVED, '1.1.0', { kind: 'tenant' }),
  pin(SERVED, '0.9.0', { kind: 'project', projectId: PROD }),
  pin(SERVED, '1.0.0', {
    kind: 'segment',
    projectId: PROD,
    path: [{ key: 'plan', value: 'pro' }],
  }),
  pin(SOLO, '1.0.0', { kind: 'org', orgId: ORG as never }),
];

/** A fake binding: `listCovering` answers the page each test sets, `issuedCursor` knows `c-…`. */
function fakeLive(opts: { covering?: boolean } = {}) {
  const asked: ListCoveringPinsInput[] = [];
  const state: { page: { data: readonly LivePin[]; nextCursor?: Cursor } } = {
    page: { data: COVERING_PROD },
  };
  const live: LiveVersionBinding = {
    resolve: async () => null,
    list: async () => [],
    issuedCursor: (_list, cursor) => (cursor as unknown as string).startsWith('c-'),
    ...(opts.covering !== false && {
      listCovering: async (input: ListCoveringPinsInput) => {
        asked.push(input);
        return state.page;
      },
    }),
  };
  return { live, asked, state };
}

const projects = {
  get: async (_tenant: TenantId, projectId: ProjectId) =>
    [STAGING, PROD, OTHER].includes(projectId) ? { projectId, tenantId } : undefined,
} as unknown as ProjectBinding;

function harness(
  opts: {
    covering?: boolean;
    withProjects?: boolean;
    /** With an authorizer and item rights, as a runtime has; else no authorization at all. */
    rights?: boolean;
  } = {},
) {
  const fake = fakeLive(opts);
  const authz = grantsAuthz(PEOPLE);
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: createStubBinding<RunHandlerBinding>('runHandler', {
      invokeAgent: true,
      invokeFlow: true,
      resumeRun: true,
    }),
    agentReleases: {
      live: fake.live,
      promotions: {} as AgentReleaseBindings['promotions'],
    },
    ...(opts.withProjects !== false && { projectBinding: projects }),
    ...(opts.rights === true && { authz: authz.authz, itemProjects: itemProjects(rows()) }),
  });
  const list = async (who: string, projectId: string, query = '') => {
    const res = await app.request(`/v1/projects/${projectId}/pinned-versions${query}`, {
      headers: { authorization: `Bearer ${who}` },
    });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as Record<string, any> };
  };
  return { list, ...fake };
}

const versions = (body: Record<string, any>) =>
  (body.data as { agentId: string; version: string }[]).map((p) => `${p.agentId}@${p.version}`);

describe('GET /v1/projects/:projectId/pinned-versions', () => {
  test("lists each pin as an agent's live-versions does, every scope kind on the wire", async () => {
    const { list, asked } = harness();
    const res = await list('anyone', PROD);
    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual({
      data: [
        {
          agentId: SERVED,
          scope: { kind: 'tenant' },
          version: '1.1.0',
          promotionId: `p-${SERVED}-1.1.0`,
          setAt: NOW,
        },
        {
          agentId: SERVED,
          scope: { kind: 'project', projectId: PROD },
          version: '0.9.0',
          promotionId: `p-${SERVED}-0.9.0`,
          setAt: NOW,
        },
        {
          agentId: SERVED,
          scope: { kind: 'segment', projectId: PROD, path: [{ key: 'plan', value: 'pro' }] },
          version: '1.0.0',
          promotionId: `p-${SERVED}-1.0.0`,
          setAt: NOW,
        },
        {
          agentId: SOLO,
          scope: { kind: 'org', orgId: ORG },
          version: '1.0.0',
          promotionId: `p-${SOLO}-1.0.0`,
          setAt: NOW,
        },
      ],
      hasMore: false,
    });
    expect(asked).toEqual([{ tenantId, projectId: PROD, limit: 25 }]);
  });

  test('pages as the promotions list does: limit, a cursor it issued, hasMore', async () => {
    const { list, asked, state } = harness();
    state.page = { data: COVERING_PROD.slice(0, 1), nextCursor: 'c-1' as Cursor };
    const first = await list('anyone', PROD, '?limit=1');
    expect(first.body).toMatchObject({ hasMore: true, nextCursor: 'c-1' });
    state.page = { data: COVERING_PROD.slice(1, 2) };
    const last = await list('anyone', PROD, '?limit=1&cursor=c-1');
    expect(last.body.hasMore).toBe(false);
    expect(last.body).not.toHaveProperty('nextCursor');
    await list('anyone', PROD, '?limit=500');
    expect(asked).toEqual([
      { tenantId, projectId: PROD, limit: 1 },
      { tenantId, projectId: PROD, limit: 1, cursor: 'c-1' },
      { tenantId, projectId: PROD, limit: 100 },
    ]);
  });

  test("a cursor the binding didn't issue: 400 bad-input, before the list is read", async () => {
    const { list, asked } = harness();
    const res = await list('anyone', PROD, '?cursor=forged');
    expect(res.status, res.text).toBe(400);
    expect(res.body.error.code).toBe('bad-input');
    expect(asked).toEqual([]);
  });

  test("a project id that isn't a UUID: 400; a project that doesn't exist: 404", async () => {
    const { list, asked } = harness();
    const bad = await list('anyone', 'not-a-project');
    expect(bad.status, bad.text).toBe(400);
    expect(bad.body.error.code).toBe('bad-input');
    const missing = await list('anyone', randomUUID());
    expect(missing.status, missing.text).toBe(404);
    expect(missing.body.error.code).toBe('project-not-found');
    expect(asked).toEqual([]);
  });

  test('a binding without listCovering: 501 pinned-versions-not-supported', async () => {
    const { list } = harness({ covering: false });
    const res = await list('anyone', PROD);
    expect(res.status, res.text).toBe(501);
    expect(res.body.error.code).toBe('pinned-versions-not-supported');
  });

  test('without the project binding the route is not mounted: 404 route-not-found', async () => {
    const { list, asked } = harness({ withProjects: false });
    const res = await list('anyone', PROD);
    expect(res.status, res.text).toBe(404);
    expect(res.body.error.code).toBe('route-not-found');
    expect(asked).toEqual([]);
  });
});

describe('who sees which pin (item rights, through createApp)', () => {
  test('a caller without read on the project: 403, before the list is read', async () => {
    const { list, asked } = harness({ rights: true });
    const res = await list('prod-reader', STAGING);
    expect(res.status, res.text).toBe(403);
    expect(asked).toEqual([]);
  });

  test('an unissued cursor from a caller without read: 403, not 400', async () => {
    const { list } = harness({ rights: true });
    const res = await list('prod-reader', STAGING, '?cursor=forged');
    expect(res.status, res.text).toBe(403);
  });

  test('without listCovering, a caller without read still gets 403, not 501', async () => {
    const { list } = harness({ rights: true, covering: false });
    const res = await list('prod-reader', STAGING);
    expect(res.status, res.text).toBe(403);
  });

  test("each pin at its own version, and none whose version runs only where the caller can't read", async () => {
    const { list, state } = harness({ rights: true });
    state.page = { data: COVERING_PROD, nextCursor: 'c-4' as Cursor };
    const res = await list('prod-reader', PROD);
    expect(res.status, res.text).toBe(200);
    // The tenant pin's 1.1.0 runs in staging only: hidden. The project pin
    // shows at 0.9.0, not swapped for the newest version prod-reader sees
    // (1.0.0). The one-project agent's pin needs read on that agent.
    expect(versions(res.body)).toEqual([`${SERVED}@0.9.0`, `${SERVED}@1.0.0`]);
    expect(res.body.data[0].scope).toEqual({ kind: 'project', projectId: PROD });
    // A short page still says there's more: page on the cursor, not the count.
    expect(res.body).toMatchObject({ hasMore: true, nextCursor: 'c-4' });
  });

  test('a caller who reads both projects sees every version of the agent both serve', async () => {
    const { list } = harness({ rights: true });
    const res = await list('staging-reader', PROD);
    expect(res.status, res.text).toBe(200);
    expect(versions(res.body)).toEqual([`${SERVED}@1.1.0`, `${SERVED}@0.9.0`, `${SERVED}@1.0.0`]);
  });

  test('a caller with read on the one-project agent sees its pin', async () => {
    const { list } = harness({ rights: true });
    const res = await list('solo-reader', PROD);
    expect(res.status, res.text).toBe(200);
    expect(versions(res.body)).toEqual([`${SERVED}@0.9.0`, `${SERVED}@1.0.0`, `${SOLO}@1.0.0`]);
    expect(res.body.data[2].scope).toEqual({ kind: 'org', orgId: ORG });
  });
});
