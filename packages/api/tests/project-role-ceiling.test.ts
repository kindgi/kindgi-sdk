// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * With authorization enforced, a project's admins give every role but
 * `owner`. Giving `owner`, or changing or removing a member who holds it,
 * takes `delete` on the project: the one permission `owner` adds over
 * `admin`. A request giving `owner` asks it first, before the person is
 * looked up. A change or removal asks the binding to stop at an owner
 * (`stopAtOwner`), and only when it does is `delete` asked: allowed, the
 * call is made again without the stop; refused, it's a 403 and nothing
 * changes. Changing anyone else asks nothing more, so no refused `delete`
 * is recorded for it.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import {
  type ProjectRole,
  type TenantHierarchyBinding,
  makeInMemoryProjectBinding,
} from '@kindgi/platform';
import type { ProjectId, TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { IdentityDirectoryBinding, RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
/** Holds `admin` on the project, not `delete`. */
const projectAdmin = randomUUID() as UserId;
/** Holds `delete` on the project too: an owner, an org admin or a tenant admin. */
const deleter = randomUUID() as UserId;
const member = randomUUID() as UserId;
const PEOPLE: Record<string, UserId> = { admin: projectAdmin, deleter };

/** `<who>` or `<who>@<project>`, for a key limited to that project. */
const resolveToken: TokenResolver = async (token) => {
  const [who, keyProject] = token.split('@');
  const userId = who === undefined ? undefined : PEOPLE[who];
  if (userId === undefined) return null;
  return {
    tenantId,
    userId,
    ...(keyProject !== undefined && { tokenProjectId: keyProject }),
  };
};

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

function makeApp(options: { readonly authorized: boolean }) {
  const projects = makeInMemoryProjectBinding();
  /** Each check the store answers, as `<action> <type>`. */
  const asks: string[] = [];
  /** Each hierarchy call, with the stop it asked for. */
  const calls: string[] = [];
  /** Each directory lookup. */
  const lookups: string[] = [];

  /** Both people hold `admin` on the project; only `deleter` holds `delete`. */
  const authzCheckBinding: AuthzCheckBinding = {
    check: async (principal, action, resource) => {
      asks.push(`${action} ${resource.type}`);
      const allowed =
        resource.type !== 'project' || action !== 'delete' || principal.actor.id === deleter;
      return decision(allowed, action, resource);
    },
    checkBatch: async (_principal, action, resources) =>
      resources.map((resource) => decision(true, action, resource)),
  };

  /** The member's role on the project, as the binding reads it. */
  const roleOf = async (projectId: ProjectId, userId: UserId) =>
    (await projects.memberships.list(tenantId, projectId, { limit: 50 })).items.find(
      (m) => m.userId === userId,
    )?.role;

  // A binding that keeps rows and tuples in step, and honors `stopAtOwner`.
  const hierarchy = {
    ...createStubAppBindings().tenantHierarchyBinding,
    async addProjectMember({ projectId, userId, role }) {
      calls.push(`add ${role}`);
      await projects.memberships.add(tenantId, { projectId, userId, role });
      return { kind: 'ok', value: undefined };
    },
    async removeProjectMember({ projectId, userId, stopAtOwner }) {
      calls.push(`remove stop=${stopAtOwner === true}`);
      if (stopAtOwner === true && (await roleOf(projectId, userId)) === 'owner') {
        return {
          kind: 'err',
          error: { code: 'project-member-holds-owner', message: 'holds owner; nothing changed' },
        };
      }
      await projects.memberships.remove(tenantId, projectId, userId);
      return { kind: 'ok', value: undefined };
    },
    async updateProjectMemberRole({ projectId, userId, role, stopAtOwner }) {
      calls.push(`update ${role} stop=${stopAtOwner === true}`);
      if (stopAtOwner === true && (await roleOf(projectId, userId)) === 'owner') {
        return {
          kind: 'err',
          error: { code: 'project-member-holds-owner', message: 'holds owner; nothing changed' },
        };
      }
      const outcome = await projects.memberships.updateRole(tenantId, projectId, userId, role);
      return { kind: 'ok', value: outcome };
    },
  } as TenantHierarchyBinding;

  const directory = {
    getUser: async ({ userId }: { userId: UserId }) => {
      lookups.push(`id ${userId}`);
      return { tenantId, userId };
    },
    findUserByEmail: async ({ email }: { email: string }) => {
      lookups.push(`email ${email}`);
      return { tenantId, userId: member };
    },
  } as unknown as IdentityDirectoryBinding;

  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    tenantHierarchyBinding: hierarchy,
    projectBinding: projects.projects,
    projectMembershipBinding: projects.memberships,
    teamProjectGrantBinding: projects.grants,
    identityDirectory: directory,
    ...(options.authorized && { authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding } }),
  });
  return { app, projects, asks, calls, lookups, roleOf };
}

type Harness = ReturnType<typeof makeApp>;

async function send(h: Harness, method: string, path: string, token: string, body?: unknown) {
  const res = await h.app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: (text === '' ? {} : JSON.parse(text)) as {
      error?: { code: string; message: string; details?: Record<string, unknown> };
    },
  };
}

/** A project where `admin` holds `admin`, and the member holds `memberRole` (or nothing). */
async function seeded(h: Harness, memberRole?: ProjectRole) {
  const project = await h.projects.projects.create(tenantId, {
    name: 'Desk',
    slug: `desk-${randomUUID()}`,
  });
  if (project.kind !== 'ok') throw new Error('seed failed');
  const { projectId } = project;
  await h.projects.memberships.add(tenantId, { projectId, userId: projectAdmin, role: 'admin' });
  if (memberRole !== undefined) {
    await h.projects.memberships.add(tenantId, { projectId, userId: member, role: memberRole });
  }
  const id = projectId as unknown as string;
  return {
    projectId,
    members: `/v1/projects/${id}/memberships`,
    memberPath: `/v1/projects/${id}/memberships/${member}`,
    ownPath: `/v1/projects/${id}/memberships/${projectAdmin}`,
  };
}

const givingOwner = (projectId: ProjectId) =>
  `Permission denied: giving the owner role on project ${projectId} needs delete on it, which an owner of the project, an admin of its org or a tenant admin holds`;
const changingOwner = (projectId: ProjectId) =>
  `Permission denied: user ${member} holds the owner role on project ${projectId}, and changing or removing an owner needs delete on it`;

describe('giving owner takes delete on the project', () => {
  test("a project admin's POST naming owner is refused before the person is looked up", async () => {
    const h = makeApp({ authorized: true });
    const ids = await seeded(h);
    const answer = await send(h, 'POST', ids.members, 'admin', {
      email: 'someone@example.com',
      role: 'owner',
    });
    expect(answer.status).toBe(403);
    expect(answer.body.error).toMatchObject({
      code: 'permission-denied',
      message: givingOwner(ids.projectId),
      details: { action: 'delete', resource: `project:${ids.projectId}` },
    });
    expect(h.asks).toEqual(['admin project', 'delete project']);
    expect(h.lookups).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  test("a project admin's PATCH of their own row to owner never reaches the binding", async () => {
    const h = makeApp({ authorized: true });
    const ids = await seeded(h);
    const answer = await send(h, 'PATCH', ids.ownPath, 'admin', { role: 'owner' });
    expect(answer.status).toBe(403);
    expect(answer.body.error).toMatchObject({
      code: 'permission-denied',
      message: givingOwner(ids.projectId),
    });
    expect(h.calls).toEqual([]);
  });

  test('a caller holding delete gives owner, and the PATCH calls once, without the stop', async () => {
    const h = makeApp({ authorized: true });
    const ids = await seeded(h, 'editor');
    const added = await send(h, 'POST', ids.members, 'deleter', {
      userId: randomUUID(),
      role: 'owner',
    });
    expect(added.status).toBe(201);
    expect(h.calls).toEqual(['add owner']);

    h.calls.length = 0;
    h.asks.length = 0;
    const changed = await send(h, 'PATCH', ids.memberPath, 'deleter', { role: 'owner' });
    expect(changed.status).toBe(204);
    expect(h.calls).toEqual(['update owner stop=false']);
    expect(h.asks).toEqual(['admin project', 'delete project']);
  });

  test.each(['viewer', 'editor', 'admin'] as const)(
    'a project admin gives %s, asking nothing more',
    async (role) => {
      const h = makeApp({ authorized: true });
      const ids = await seeded(h);
      const answer = await send(h, 'POST', ids.members, 'admin', { userId: member, role });
      expect(answer.status).toBe(201);
      expect(h.asks).toEqual(['admin project']);
      expect(h.calls).toEqual([`add ${role}`]);
    },
  );
});

const CHANGES = [
  { change: 'lowering', method: 'PATCH', body: { role: 'editor' }, call: 'update editor' },
  { change: 'removing', method: 'DELETE', body: undefined, call: 'remove' },
] as const;

describe.each(CHANGES)('$change a member', (m) => {
  test('who holds owner, by a project admin: refused after the stop, nothing changed', async () => {
    const h = makeApp({ authorized: true });
    const ids = await seeded(h, 'owner');
    const answer = await send(h, m.method, ids.memberPath, 'admin', m.body);
    expect(answer.status).toBe(403);
    expect(answer.body.error).toMatchObject({
      code: 'permission-denied',
      message: changingOwner(ids.projectId),
      details: { action: 'delete', resource: `project:${ids.projectId}` },
    });
    expect(h.calls).toEqual([`${m.call} stop=true`]);
    expect(h.asks).toEqual(['admin project', 'delete project']);
    expect(await h.roleOf(ids.projectId, member)).toBe('owner');
  });

  test('who holds owner, by a caller holding delete: made again without the stop', async () => {
    const h = makeApp({ authorized: true });
    const ids = await seeded(h, 'owner');
    const answer = await send(h, m.method, ids.memberPath, 'deleter', m.body);
    expect(answer.status).toBe(204);
    expect(h.calls).toEqual([`${m.call} stop=true`, `${m.call} stop=false`]);
    expect(h.asks).toEqual(['admin project', 'delete project']);
    expect(await h.roleOf(ids.projectId, member)).toBe(m.method === 'PATCH' ? 'editor' : undefined);
  });

  test("who doesn't hold owner, by a project admin: one call, and delete is never asked", async () => {
    const h = makeApp({ authorized: true });
    const ids = await seeded(h, 'viewer');
    const answer = await send(h, m.method, ids.memberPath, 'admin', m.body);
    expect(answer.status).toBe(204);
    expect(h.calls).toEqual([`${m.call} stop=true`]);
    expect(h.asks).toEqual(['admin project']);
  });
});

describe('a key limited to a project', () => {
  test('gives owner there when its person holds delete, and is refused in another project first', async () => {
    const h = makeApp({ authorized: true });
    const ids = await seeded(h);
    const other = await seeded(h);
    const there = await send(h, 'POST', ids.members, `deleter@${ids.projectId}`, {
      userId: member,
      role: 'owner',
    });
    expect(there.status).toBe(201);
    expect(h.calls).toEqual(['add owner']);

    h.calls.length = 0;
    const elsewhere = await send(h, 'POST', other.members, `deleter@${ids.projectId}`, {
      userId: member,
      role: 'owner',
    });
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.body.error?.code).toBe('key-project-mismatch');
    expect(h.calls).toEqual([]);
  });

  test("a project admin's key naming owner is refused", async () => {
    const h = makeApp({ authorized: true });
    const ids = await seeded(h);
    const answer = await send(h, 'POST', ids.members, `admin@${ids.projectId}`, {
      userId: member,
      role: 'owner',
    });
    expect(answer.status).toBe(403);
    expect(answer.body.error).toMatchObject({ message: givingOwner(ids.projectId) });
    expect(h.calls).toEqual([]);
  });
});

describe('without authorization', () => {
  test('owner is given, changed and removed through the plain bindings, with no stop', async () => {
    const h = makeApp({ authorized: false });
    const ids = await seeded(h, 'owner');
    const added = await send(h, 'POST', ids.members, 'admin', {
      userId: randomUUID(),
      role: 'owner',
    });
    expect(added.status).toBe(201);
    const lowered = await send(h, 'PATCH', ids.memberPath, 'admin', { role: 'editor' });
    expect(lowered.status).toBe(204);
    expect(await h.roleOf(ids.projectId, member)).toBe('editor');
    const raised = await send(h, 'PATCH', ids.memberPath, 'admin', { role: 'owner' });
    expect(raised.status).toBe(204);
    const removed = await send(h, 'DELETE', ids.memberPath, 'admin');
    expect(removed.status).toBe(204);
    expect(await h.roleOf(ids.projectId, member)).toBeUndefined();
    expect(h.calls).toEqual([]);
    expect(h.asks).toEqual([]);
  });
});
