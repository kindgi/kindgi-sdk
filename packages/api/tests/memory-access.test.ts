// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `/v1/memory` with authorization on: who reads which facts, and who may
 * write, change or delete them. The readers are worked out from the
 * caller (`memory-access.ts`) and applied by the binding (here the
 * in-memory reference, whose `readable` the runtime's SQL matches).
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { MemoryScope } from '@kindgi/memory';
import type { Project, ProjectBinding } from '@kindgi/platform';
import type { OrgId, ProjectId, TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';
import { type InMemoryMemory, inMemoryMemory, readable } from './support/in-memory-memory.js';

const tenantId = randomUUID() as TenantId;
const orgA = 'org-acme' as OrgId;
const projectA = randomUUID() as ProjectId;
const projectB = randomUUID() as ProjectId;

const USER_1 = 'user-1-token';
const USER_2 = 'user-2-token';
const APP_KEY = 'app-key-token';
const ADMIN = 'admin-token';

const resolveToken: TokenResolver = async (token) => {
  if (token === USER_1) return { tenantId, userId: 'user-1' as UserId };
  if (token === USER_2) return { tenantId, userId: 'user-2' as UserId };
  if (token === APP_KEY) return { tenantId, tokenId: 'key-1' as never };
  if (token === ADMIN) return { tenantId, userId: 'admin-1' as UserId };
  return null;
};

/** `action type:id` pairs each principal holds. */
const GRANTS: Readonly<Record<string, readonly string[]>> = {
  'user-1': [`read project:${projectA}`],
  'user-2': [],
  'key-1': [`read project:${projectA}`, `write project:${projectA}`],
  'admin-1': [`admin tenant:${tenantId}`],
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

function project(id: ProjectId, orgId?: OrgId): Project {
  return { id, tenantId, ...(orgId !== undefined && { orgId }) } as unknown as Project;
}

interface Harness {
  readonly memory: InMemoryMemory;
  readonly projectLists: number[];
  readonly call: (
    method: string,
    path: string,
    token: string,
    body?: unknown,
  ) => Promise<{ readonly status: number; readonly body: Record<string, any> }>;
}

function harness(authz: AuthzCheckBinding = checkOnly): Harness {
  const memory = inMemoryMemory();
  const projectLists: number[] = [];
  const projectBinding = {
    list: async () => {
      projectLists.push(1);
      return { items: [project(projectA, orgA), project(projectB)] };
    },
  } as unknown as ProjectBinding;
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    memory: memory.binding,
    projectBinding,
    authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding: authz },
  });
  const call: Harness['call'] = async (method, path, token, body) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { memory, projectLists, call };
}

/** Seed one fact per kind of scope, straight into the binding. */
async function seed(h: Harness): Promise<Record<string, string>> {
  const scopes: Record<string, Partial<MemoryScope>> = {
    tenant: {},
    org: { orgId: orgA },
    projectA: { projectId: projectA },
    projectB: { projectId: projectB },
    user1: { userId: 'user-1' as UserId },
    user2: { userId: 'user-2' as UserId },
    participant: { projectId: projectA, participantId: 'end-user-7' },
    thread: { projectId: projectA, threadId: randomUUID() as never },
  };
  const ids: Record<string, string> = {};
  for (const [name, scope] of Object.entries(scopes)) {
    const out = await h.memory.binding.writeFact({
      tenantId,
      type: 'acme.note',
      scope: { tenantId, ...scope },
      content: { name },
    });
    if (out.kind !== 'ok') throw new Error(`seed ${name}: ${out.kind}`);
    ids[name] = out.fact.id as unknown as string;
  }
  return ids;
}

async function visibleNames(h: Harness, token: string): Promise<string[]> {
  const res = await h.call('GET', '/v1/memory/facts?limit=100', token);
  expect(res.status).toBe(200);
  return (res.body.data as { content: { name: string } }[]).map((f) => f.content.name).sort();
}

describe('API — memory readers', () => {
  test('a project reader sees tenant-wide, its project and its org, and only its own user facts', async () => {
    const h = harness();
    await seed(h);
    expect(await visibleNames(h, USER_1)).toEqual(['org', 'projectA', 'tenant', 'user1']);
  });

  test('another user sees neither user-1 facts nor a project it may not read', async () => {
    const h = harness();
    const ids = await seed(h);
    expect(await visibleNames(h, USER_2)).toEqual(['tenant', 'user2']);
    // Not found, as if it didn't exist: a fact it may not see.
    const res = await h.call('GET', `/v1/memory/facts/${ids.user1}`, USER_2);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('fact-not-found');
  });

  test("an app's key that writes the project reads its end users' and conversations' facts", async () => {
    const h = harness();
    await seed(h);
    expect(await visibleNames(h, APP_KEY)).toEqual([
      'org',
      'participant',
      'projectA',
      'tenant',
      'thread',
    ]);
  });

  test('a tenant admin reads every fact', async () => {
    const h = harness();
    await seed(h);
    expect(await visibleNames(h, ADMIN)).toHaveLength(8);
  });

  test('with ListObjects the readers come from the listing, not a walk over the projects', async () => {
    const h = harness(withList);
    await seed(h);
    // `read org` isn't granted to the key, so the listing gives no org.
    expect(await visibleNames(h, APP_KEY)).toEqual(['participant', 'projectA', 'tenant', 'thread']);
    expect(h.projectLists).toEqual([]);
  });

  test('every read hands the binding the readers; the reference guard agrees', async () => {
    const h = harness();
    await seed(h);
    await h.call('GET', '/v1/memory/facts', USER_1);
    const readers = h.memory.readersSeen.at(-1)!;
    expect(readers.all).toBeUndefined();
    expect(readers.projectIds).toEqual([projectA]);
    expect(readers.orgIds).toEqual([orgA]);
    expect(readers.userIds).toEqual(['user-1']);
    expect(readable({ tenantId, projectId: projectB }, readers)).toBe(false);
    expect(readable({ tenantId, projectId: projectA, participantId: 'p' }, readers)).toBe(false);
  });
});

describe('API — memory write checks', () => {
  const write = (scope: Readonly<Record<string, unknown>>) => ({
    type: 'acme.note',
    scope: { tenantId, ...scope },
    content: 'x',
  });

  test.each([
    ['a tenant-wide fact', {}, 'needs admin on the tenant'],
    [
      'another user’s fact',
      { userId: 'user-2' },
      "Only that user (or a tenant admin) can write a user's memory.",
    ],
    ['a fact in a project it only reads', { projectId: projectA }, 'needs write on it'],
    ['an org-wide fact', { orgId: orgA }, 'needs admin on org'],
  ])('a reader may not write %s', async (_name, scope, why) => {
    const h = harness();
    const res = await h.call('POST', '/v1/memory/facts', USER_1, write(scope));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('permission-denied');
    expect(res.body.error.message).toContain(why);
    expect(h.memory.rows).toEqual([]);
  });

  test('a user writes their own facts; the key writes its project and its end users', async () => {
    const h = harness();
    const own = await h.call('POST', '/v1/memory/facts', USER_1, write({ userId: 'user-1' }));
    expect(own.status).toBe(201);
    expect(own.body.attributedTo).toEqual({ kind: 'user', id: 'user-1' });
    const forEndUser = await h.call(
      'POST',
      '/v1/memory/facts',
      APP_KEY,
      write({ projectId: projectA, participantId: 'end-user-7' }),
    );
    expect(forEndUser.status).toBe(201);
    expect(forEndUser.body.attributedTo).toEqual({ kind: 'service', id: 'key-1' });
  });

  test('change and delete: hidden facts are not found, readable ones need write', async () => {
    const h = harness();
    const ids = await seed(h);
    const hidden = await h.call('DELETE', `/v1/memory/facts/${ids.user1}`, USER_2);
    expect(hidden.status).toBe(404);
    const readOnly = await h.call('POST', `/v1/memory/facts/${ids.projectA}/supersede`, USER_1, {
      content: 'changed',
    });
    expect(readOnly.status).toBe(403);
    const verify = await h.call('POST', `/v1/memory/facts/${ids.projectA}/verify`, USER_1);
    expect(verify.status).toBe(403);
    const byKey = await h.call('POST', `/v1/memory/facts/${ids.projectA}/supersede`, APP_KEY, {
      content: 'changed',
    });
    expect(byKey.status).toBe(200);
    expect(byKey.body.version).toBe(2);
    expect(byKey.body.attributedTo).toEqual({ kind: 'service', id: 'key-1' });
    const deleted = await h.call('DELETE', `/v1/memory/facts/${ids.user1}`, USER_1);
    expect(deleted.status).toBe(200);
    expect(deleted.body.invalidatedBy).toBe('user:user-1');
  });
});
