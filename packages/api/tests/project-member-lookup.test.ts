// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Adding a project member names a person of the tenant, by id or by
 * email, and the route resolves it through the identity directory:
 * someone who isn't a person of this tenant, or was removed from it, is
 * refused (`404 identity-user-not-found`) and nothing is added. A project
 * admin who can't list the tenant's people adds a member this way.
 *
 * `GET /v1/projects/default` is checked as `GET /v1/projects/{id}` is:
 * someone with a role on another project only can't read the Default.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import { type TenantHierarchyBinding, makeInMemoryProjectBinding } from '@kindgi/platform';
import { createStubAppBindings } from '@kindgi/testing';
import type { TenantId, Timestamp, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type { IdentityDirectoryBinding, RunHandlerBinding, UserRecord } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const admin = randomUUID() as UserId;
/** Admin on one project (`theirs`), nothing else. */
const projectAdmin = randomUUID() as UserId;
const alice = randomUUID() as UserId;
/** Removed from the tenant. */
const bob = randomUUID() as UserId;

const TOKENS: Record<string, UserId> = {
  'admin-token': admin,
  'project-admin-token': projectAdmin,
  'admin-member-key': admin,
  'project-admin-member-key': projectAdmin,
};

const person = (userId: UserId, email: string, removed = false): UserRecord => ({
  userId,
  tenantId,
  primaryEmail: email,
  displayName: email.split('@')[0] ?? email,
  createdAt: '2026-10-01T00:00:00.000Z' as Timestamp,
  ...(removed && { unregisteredAt: '2026-10-05T00:00:00.000Z' as Timestamp }),
});
const PEOPLE = [person(alice, 'alice@acme.test'), person(bob, 'bob@acme.test', true)];

/** The tenant's people. Lookups return removed people too: the route must not take them. */
function directory(withEmailLookup: boolean): IdentityDirectoryBinding {
  return {
    getUser: async ({ userId }) => PEOPLE.find((p) => p.userId === userId) ?? null,
    listUsers: async () => ({ data: PEOPLE }),
    listSessions: async () => ({ data: [] }),
    revokeAllSessions: async ({ userId }) => ({ userId, revokedCount: 0 }),
    ...(withEmailLookup && {
      findUserByEmail: async ({ email }) =>
        PEOPLE.find((p) => p.primaryEmail?.toLowerCase() === email.toLowerCase()) ?? null,
    }),
  };
}

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
};

const decision = (allowed: boolean, action: Action, resource: ResourceRef): Decision => ({
  allowed,
  reason: allowed ? 'test: allowed' : 'test: denied',
  evidence: { action, relation: '', resource: `${resource.type}:${resource.id}`, actorSubject: '' },
});

async function makeApp(options: {
  readonly authorized: boolean;
  readonly emailLookup?: boolean;
}) {
  const projects = makeInMemoryProjectBinding();
  const created = await Promise.all([
    projects.projects.create(tenantId, { name: 'Default', slug: 'default', isDefault: true }),
    projects.projects.create(tenantId, { name: 'Theirs', slug: 'theirs' }),
  ]);
  const [defaultId, theirs] = created.map((c) => {
    if (c.kind !== 'ok') throw new Error('seed failed');
    return c.projectId as unknown as string;
  }) as [string, string];
  /** The admin may do anything; the project admin, anything on their project. */
  const allowed = (actor: string, resource: ResourceRef) =>
    actor === admin ||
    (actor === projectAdmin && resource.type === 'project' && resource.id === theirs);
  const authzCheckBinding: AuthzCheckBinding = {
    check: async (p, action, resource) => decision(allowed(p.actor.id, resource), action, resource),
    checkBatch: async (p, action, resources) =>
      resources.map((resource) => decision(allowed(p.actor.id, resource), action, resource)),
  };
  const hierarchy = {
    ...createStubAppBindings().tenantHierarchyBinding,
    async addProjectMember({ projectId, userId, role }) {
      await projects.memberships.add(tenantId, { projectId, userId, role });
      return { kind: 'ok', value: undefined };
    },
  } as TenantHierarchyBinding;
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken: async (token) =>
      TOKENS[token] === undefined
        ? null
        : {
            tenantId,
            userId: TOKENS[token],
            ...(token.endsWith('-member-key') && { tokenRole: 'member' as const }),
          },
    runHandler,
    tenantHierarchyBinding: hierarchy,
    projectBinding: projects.projects,
    projectMembershipBinding: projects.memberships,
    teamProjectGrantBinding: projects.grants,
    identityDirectory: directory(options.emailLookup !== false),
    ...(options.authorized && { authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding } }),
  });
  const members = async (projectId: string) =>
    (await projects.memberships.list(tenantId, projectId as never, { limit: 10 })).items.map(
      (m) => m.userId as unknown as string,
    );
  return { app, defaultId, theirs, members };
}

async function send(
  app: Awaited<ReturnType<typeof makeApp>>['app'],
  method: string,
  path: string,
  body?: unknown,
  token = 'admin-token',
) {
  const res = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> & {
      error?: { code: string; message: string };
    },
  };
}

describe.each([false, true])(
  'adding a project member (authorization enforced: %s)',
  (authorized) => {
    test('by email: the person it names, as the directory matches it; the answer has their id', async () => {
      const a = await makeApp({ authorized });
      const res = await send(a.app, 'POST', `/v1/projects/${a.theirs}/memberships`, {
        email: ' Alice@ACME.test ',
        role: 'viewer',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toEqual({ projectId: a.theirs, userId: alice, role: 'viewer' });
      expect(await a.members(a.theirs)).toEqual([alice]);
    });

    test('by id: a person of the tenant', async () => {
      const a = await makeApp({ authorized });
      const res = await send(a.app, 'POST', `/v1/projects/${a.theirs}/memberships`, {
        userId: alice,
        role: 'editor',
      });
      expect(res.status).toBe(201);
      expect(await a.members(a.theirs)).toEqual([alice]);
    });

    test('someone who is not a person of this tenant, or was removed: 404, nothing added', async () => {
      const a = await makeApp({ authorized });
      for (const named of [
        { email: 'carol@acme.test' },
        { userId: randomUUID() },
        { userId: bob },
        { email: 'bob@acme.test' },
      ]) {
        const res = await send(a.app, 'POST', `/v1/projects/${a.theirs}/memberships`, {
          ...named,
          role: 'viewer',
        });
        expect(res.status, JSON.stringify(named)).toBe(404);
        expect(res.body.error?.code).toBe('identity-user-not-found');
        expect(res.body.error?.message).toContain('a member of this tenant');
      }
      expect(await a.members(a.theirs)).toEqual([]);
    });

    test('exactly one of userId and email: 400', async () => {
      const a = await makeApp({ authorized });
      for (const body of [
        { role: 'viewer' },
        { userId: alice, email: 'alice@acme.test', role: 'viewer' },
        { email: '  ', role: 'viewer' },
        { userId: '', role: 'viewer' },
      ]) {
        const res = await send(a.app, 'POST', `/v1/projects/${a.theirs}/memberships`, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.error?.code).toBe('bad-input');
      }
    });

    test("a directory that doesn't look people up by email: 400 for an email; an id still works", async () => {
      const a = await makeApp({ authorized, emailLookup: false });
      const byEmail = await send(a.app, 'POST', `/v1/projects/${a.theirs}/memberships`, {
        email: 'alice@acme.test',
        role: 'viewer',
      });
      expect(byEmail.status).toBe(400);
      expect(byEmail.body.error?.message).toContain('userId');
      const byId = await send(a.app, 'POST', `/v1/projects/${a.theirs}/memberships`, {
        userId: alice,
        role: 'viewer',
      });
      expect(byId.status).toBe(201);
    });
  },
);

describe('with authorization enforced', () => {
  test("a project admin, who can't list the tenant's people, adds a member by email", async () => {
    const a = await makeApp({ authorized: true });
    const list = await send(a.app, 'GET', '/v1/identity/users', undefined, 'project-admin-token');
    expect(list.status).toBe(403);
    const res = await send(
      a.app,
      'POST',
      `/v1/projects/${a.theirs}/memberships`,
      { email: 'alice@acme.test', role: 'viewer' },
      'project-admin-token',
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await a.members(a.theirs)).toEqual([alice]);
  });

  test("a member key: its person's project admin holds; tenant admin doesn't", async () => {
    const a = await makeApp({ authorized: true });
    const added = await send(
      a.app,
      'POST',
      `/v1/projects/${a.theirs}/memberships`,
      { email: 'alice@acme.test', role: 'viewer' },
      'project-admin-member-key',
    );
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    // A tenant admin's member key lists no people: that's a tenant admin's.
    const list = await send(a.app, 'GET', '/v1/identity/users', undefined, 'admin-member-key');
    expect([list.status, list.body.error?.code]).toEqual([403, 'permission-denied']);
  });

  test('GET /v1/projects/default: 200 to someone who can read it', async () => {
    const a = await makeApp({ authorized: true });
    const res = await send(a.app, 'GET', '/v1/projects/default');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(a.defaultId);
  });

  test('GET /v1/projects/default: 403 to someone with a role on another project only', async () => {
    const a = await makeApp({ authorized: true });
    const res = await send(a.app, 'GET', '/v1/projects/default', undefined, 'project-admin-token');
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('permission-denied');
    expect(JSON.stringify(res.body)).not.toContain('"Default"');
    // Their own project, as before.
    const own = await send(
      a.app,
      'GET',
      `/v1/projects/${a.theirs}`,
      undefined,
      'project-admin-token',
    );
    expect(own.status).toBe(200);
  });
});
