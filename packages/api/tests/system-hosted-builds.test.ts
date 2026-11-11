// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { type Context, Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import {
  type Action,
  type Decision,
  type Principal,
  type ResourceRef,
  ref,
  userPrincipal,
} from '@kindgi/authz';
import type { TenantId } from '@kindgi/types';

import type { Authorizer } from '../src/middleware/authorize.js';
import { projectOnlyCaller } from '../src/routes/system-hosted-builds.js';
import type { AppEnv } from '../src/types.js';

const PROJECT = randomUUID();
const OTHER = randomUUID();
const tenantId = randomUUID() as TenantId;
const WRITER = userPrincipal('user-writer', tenantId);
const READER = userPrincipal('user-reader', tenantId);
const c = {} as Context<AppEnv>;

/**
 * The runtime's own authorizer: it allows the caller everything, answers
 * `canFor` as true for `WRITER` writing `PROJECT` alone, and notes each
 * `canFor` and `record` it's given.
 */
function runtimeAuthorizer() {
  const asked: { principal: Principal; action: Action; resource: ResourceRef }[] = [];
  const recorded: { action: Action; resource: ResourceRef; decision: Decision }[] = [];
  const allowed: Decision = {
    allowed: true,
    reason: 'allowed',
    evidence: { action: 'read', relation: '', resource: '', actorSubject: '' },
  };
  const real: Authorizer = {
    authorize: () => async (_c, next) => next(),
    can: async () => true,
    check: async () => allowed,
    canFor: async (_c, principal, action, resource) => {
      asked.push({ principal, action, resource });
      return principal === WRITER && action === 'write' && resource.id === PROJECT;
    },
    filterByCan: async (_c, _action, items) => [...items],
    record: (_c, action, resource, decision) => {
      recorded.push({ action, resource, decision });
    },
  };
  return { real, asked, recorded };
}

describe("projectOnlyCaller: a hosted build's key, as the caller", () => {
  test('reads and administers the project the body names, and nothing else', async () => {
    const { real } = runtimeAuthorizer();
    const caller = projectOnlyCaller(real, PROJECT);
    expect(await caller.can(c, 'read', ref('project', PROJECT))).toBe(true);
    expect(await caller.can(c, 'admin', ref('project', PROJECT))).toBe(true);
    expect(await caller.can(c, 'write', ref('project', PROJECT))).toBe(false);
    expect(await caller.can(c, 'read', ref('project', OTHER))).toBe(false);
    expect(await caller.can(c, 'read', ref('agent', PROJECT))).toBe(false);
    expect(await caller.check(c, 'admin', ref('project', PROJECT))).toMatchObject({
      allowed: true,
    });
    expect(await caller.check(c, 'delete', ref('project', PROJECT))).toMatchObject({
      allowed: false,
      failing: 'scope',
      evidence: { action: 'delete', resource: `project:${PROJECT}` },
    });
  });

  test('its lists and filters hold the same line', async () => {
    const { real } = runtimeAuthorizer();
    const caller = projectOnlyCaller(real, PROJECT);
    expect(
      await caller.filterByCan(c, 'read', [PROJECT, OTHER], (id) => ref('project', id)),
    ).toEqual([PROJECT]);
    const many = await caller.checkMany?.(c, 'admin', [
      ref('project', PROJECT),
      ref('project', OTHER),
    ]);
    expect(many?.map((one) => one.allowed)).toEqual([true, false]);
    expect(await caller.checkServedBy?.(c, 'read', ref('project', PROJECT), [])).toMatchObject({
      allowed: true,
    });
    expect(await caller.listObjects?.(c, 'read', 'project')).toEqual([PROJECT]);
    expect(await caller.listObjects?.(c, 'write', 'project')).toEqual([]);
    expect(await caller.listObjects?.(c, 'read', 'agent')).toEqual([]);
  });

  test('a body that names no project reaches nothing', async () => {
    const { real } = runtimeAuthorizer();
    const caller = projectOnlyCaller(real, undefined);
    expect(await caller.can(c, 'read', ref('project', PROJECT))).toBe(false);
    expect(await caller.can(c, 'admin', ref('project', PROJECT))).toBe(false);
    expect(await caller.listObjects?.(c, 'read', 'project')).toEqual([]);
  });

  test("a check for anyone else is the runtime's own: canFor goes to it as asked, and answers as it does", async () => {
    const { real, asked } = runtimeAuthorizer();
    const caller = projectOnlyCaller(real, PROJECT);
    // The key itself can't write the project; the person who can still does.
    expect(await caller.can(c, 'write', ref('project', PROJECT))).toBe(false);
    expect(await caller.canFor(c, WRITER, 'write', ref('project', PROJECT))).toBe(true);
    // And one who can't is refused, though the key administers the project.
    expect(await caller.canFor(c, READER, 'write', ref('project', PROJECT))).toBe(false);
    expect(asked).toEqual([
      { principal: WRITER, action: 'write', resource: ref('project', PROJECT) },
      { principal: READER, action: 'write', resource: ref('project', PROJECT) },
    ]);
  });

  test("its refusals are recorded through the runtime's authorizer, and so is a route's own", async () => {
    const { real, recorded } = runtimeAuthorizer();
    const caller = projectOnlyCaller(real, PROJECT);
    await caller.can(c, 'read', ref('project', PROJECT));
    await caller.can(c, 'read', ref('project', OTHER));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      action: 'read',
      resource: ref('project', OTHER),
      decision: { allowed: false },
    });
    const own: Decision = {
      allowed: false,
      reason: "a route's own refusal",
      evidence: { action: 'admin', relation: '', resource: `project:${PROJECT}`, actorSubject: '' },
    };
    caller.record?.(c, 'admin', ref('project', PROJECT), own);
    expect(recorded[1]).toEqual({
      action: 'admin',
      resource: ref('project', PROJECT),
      decision: own,
    });
  });

  test('authorize: the named project passes; anything else is 403 permission-denied', async () => {
    const { real } = runtimeAuthorizer();
    const caller = projectOnlyCaller(real, PROJECT);
    const app = new Hono<AppEnv>();
    app.get(
      '/projects/:id',
      caller.authorize('admin', (ctx) => ref('project', ctx.req.param('id'))),
      (ctx) => ctx.json({ ok: true }),
    );
    expect((await app.request(`/projects/${PROJECT}`)).status).toBe(200);
    const refused = await app.request(`/projects/${OTHER}`);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: 'permission-denied' } });
  });
});
