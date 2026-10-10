// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Who has access to a project, and how (`GET /v1/projects/:projectId/access`):
 *
 * - its editors and admins read it (`write`); a viewer doesn't;
 * - emails show to the project's admins only;
 * - each one's role is the highest any way in gives (an org's or the
 *   tenant's admins are admins; `member` is a viewer), and their ways in
 *   come highest first;
 * - ordered by role, then name (unnamed last), then id, and paged by a
 *   cursor that carries that position;
 * - 501 from a runtime that can't say; 404 for an unknown project.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import { makeInMemoryProjectBinding } from '@kindgi/platform';
import type { TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { ProjectAccessHolder, RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const PEOPLE = ['admin', 'editor', 'viewer'] as const;
type Person = (typeof PEOPLE)[number];
const ids = Object.fromEntries(PEOPLE.map((p) => [p, randomUUID() as UserId])) as Record<
  Person,
  UserId
>;
const resolveToken: TokenResolver = async (token) => {
  const who = PEOPLE.find((p) => token === `${p}-token`);
  return who === undefined ? null : { tenantId, userId: ids[who] };
};
const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
};

function allowed(who: Person | undefined, action: Action): boolean {
  if (who === 'admin') return true;
  if (who === 'editor') return action === 'read' || action === 'write';
  if (who === 'viewer') return action === 'read';
  return false;
}
const decision = (ok: boolean, action: Action, resource: ResourceRef): Decision => ({
  allowed: ok,
  reason: ok ? 'test: allowed' : 'test: denied',
  evidence: { action, relation: '', resource: `${resource.type}:${resource.id}`, actorSubject: '' },
});
const personOf = (id: string) => PEOPLE.find((p) => ids[p] === id);
const authzCheckBinding: AuthzCheckBinding = {
  check: async (principal, action, resource) =>
    decision(allowed(personOf(principal.actor.id), action), action, resource),
  checkBatch: async (principal, action, resources) =>
    resources.map((r) => decision(allowed(personOf(principal.actor.id), action), action, r)),
};

const user = (id: string) => ({ kind: 'user' as const, id });
const HOLDERS: ProjectAccessHolder[] = [
  {
    principal: user('u-viewer-unnamed'),
    via: [{ kind: 'direct', role: 'member', joinedAt: '2026-10-01T00:00:00.000Z' }],
  },
  {
    principal: { kind: 'service-account', id: 'sa-ci' },
    displayName: 'acme-ci',
    via: [{ kind: 'direct', role: 'viewer', joinedAt: '2026-10-02T00:00:00.000Z' }],
  },
  {
    principal: user('u-ben'),
    displayName: 'Ben',
    primaryEmail: 'ben@acme.example',
    via: [{ kind: 'team', teamId: 't-1', teamName: 'Support crew', role: 'editor' }],
  },
  {
    principal: user('u-ada'),
    displayName: 'Ada',
    primaryEmail: 'ada@acme.example',
    via: [
      { kind: 'direct', role: 'editor', joinedAt: '2026-09-01T00:00:00.000Z' },
      { kind: 'tenant-admin' },
    ],
  },
  {
    principal: user('u-olga'),
    displayName: 'olga',
    via: [{ kind: 'direct', role: 'owner' }],
  },
  {
    principal: user('u-cy'),
    displayName: 'Cy',
    via: [{ kind: 'org-admin', orgId: 'o-1', orgName: 'Acme EU' }],
  },
];

function makeApp(options: { readonly binding?: boolean } = {}) {
  const projects = makeInMemoryProjectBinding();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    projectBinding: projects.projects,
    projectMembershipBinding: projects.memberships,
    ...(options.binding !== false && {
      projectAccess: {
        list: async ({ projectId }) =>
          (await projects.projects.get(tenantId, projectId)) === undefined ? null : HOLDERS,
      },
    }),
    authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
  });
  const call = async (who: Person, path: string) => {
    const res = await app.request(path, { headers: { authorization: `Bearer ${who}-token` } });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const seed = async () => {
    const p = await projects.projects.create(tenantId, {
      name: 'Support',
      slug: `s-${randomUUID()}`,
    });
    if (p.kind !== 'ok') throw new Error('seed failed');
    return p.projectId as unknown as string;
  };
  return { call, seed };
}

describe('who has access to a project', () => {
  test("its editors and admins read it; a viewer doesn't", async () => {
    const h = makeApp();
    const p = await h.seed();
    const viewer = await h.call('viewer', `/v1/projects/${p}/access`);
    expect([viewer.status, viewer.body.error?.code]).toEqual([403, 'permission-denied']);
    expect((await h.call('editor', `/v1/projects/${p}/access`)).status).toBe(200);
    expect((await h.call('admin', `/v1/projects/${p}/access`)).status).toBe(200);
  });

  test("each one's role, their ways in, the order, and emails for admins only", async () => {
    const h = makeApp();
    const p = await h.seed();
    const asAdmin = await h.call('admin', `/v1/projects/${p}/access?limit=100`);
    expect(asAdmin.body).toEqual({
      data: [
        {
          principal: user('u-olga'),
          displayName: 'olga',
          role: 'owner',
          via: [{ kind: 'direct', role: 'owner' }],
        },
        {
          principal: user('u-ada'),
          displayName: 'Ada',
          primaryEmail: 'ada@acme.example',
          role: 'admin',
          via: [
            { kind: 'tenant-admin' },
            { kind: 'direct', role: 'editor', joinedAt: '2026-09-01T00:00:00.000Z' },
          ],
        },
        {
          principal: user('u-cy'),
          displayName: 'Cy',
          role: 'admin',
          via: [{ kind: 'org-admin', orgId: 'o-1', orgName: 'Acme EU' }],
        },
        {
          principal: user('u-ben'),
          displayName: 'Ben',
          primaryEmail: 'ben@acme.example',
          role: 'editor',
          via: [{ kind: 'team', teamId: 't-1', teamName: 'Support crew', role: 'editor' }],
        },
        {
          principal: { kind: 'service-account', id: 'sa-ci' },
          displayName: 'acme-ci',
          role: 'viewer',
          via: [{ kind: 'direct', role: 'viewer', joinedAt: '2026-10-02T00:00:00.000Z' }],
        },
        {
          principal: user('u-viewer-unnamed'),
          role: 'viewer',
          via: [{ kind: 'direct', role: 'member', joinedAt: '2026-10-01T00:00:00.000Z' }],
        },
      ],
      hasMore: false,
    });
    const asEditor = await h.call('editor', `/v1/projects/${p}/access?limit=100`);
    expect(asEditor.body.data.map((e: Record<string, unknown>) => e.primaryEmail)).toEqual(
      Array(HOLDERS.length).fill(undefined),
    );
  });

  test('pages by a cursor that carries the position; a cursor it never gave is a 400', async () => {
    const h = makeApp();
    const p = await h.seed();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await h.call(
        'admin',
        `/v1/projects/${p}/access?limit=2${cursor === undefined ? '' : `&cursor=${cursor}`}`,
      );
      seen.push(...page.body.data.map((e: { principal: { id: string } }) => e.principal.id));
      if (!page.body.hasMore) break;
      cursor = page.body.nextCursor;
    }
    expect(seen).toEqual(['u-olga', 'u-ada', 'u-cy', 'u-ben', 'sa-ci', 'u-viewer-unnamed']);
    const bad = await h.call('admin', `/v1/projects/${p}/access?cursor=nope`);
    expect([bad.status, bad.body.error?.code]).toEqual([400, 'bad-input']);
  });

  test("501 from a runtime that can't say; 404 for an unknown project", async () => {
    const without = makeApp({ binding: false });
    const p = await without.seed();
    const r = await without.call('admin', `/v1/projects/${p}/access`);
    expect([r.status, r.body.error?.code]).toEqual([501, 'project-access-unsupported']);
    const h = makeApp();
    const unknown = await h.call('admin', `/v1/projects/${randomUUID()}/access`);
    expect([unknown.status, unknown.body.error?.code]).toEqual([404, 'project-not-found']);
  });
});
