// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { ProjectId, TenantId, Timestamp, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { applySiteChange, createApp } from '../src/index.js';
import type {
  RunHandlerBinding,
  Site,
  SiteBinding,
  SiteEnrollOutcome,
  SitePersonRestoreInput,
  SitePersonRestoreOutcome,
  SiteRegisterInput,
  SiteSignInOutcome,
  TokenResolver,
} from '../src/index.js';

/**
 * The sites routes are thin: a tenant admin's settings are checked (an
 * https origin, an approvals URL on it, a role map over allowed roles and
 * under the ceiling) before the binding is asked, and the two public
 * routes check a body's size and shape, pass the client's address, and
 * map the binding's answers. Everything else is the binding's.
 */

const tenantId = randomUUID() as TenantId;
const P1 = randomUUID();
const ADMIN = 'kgi_ak_test_admin';
const MEMBER = 'kgi_ak_test_member';
const NOW = '2026-10-11T18:00:00.000Z' as Timestamp;
const STATEMENT = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2ln';

/** Ada is the tenant admin: `admin` on the tenant is hers alone. */
const authz = {
  fgaApiUrl: 'http://fga.invalid',
  authzCheckBinding: {
    check: async (
      principal: { actor: { id: string } },
      action: string,
      resource: { type: string; id: string },
    ) => {
      const allowed =
        !(action === 'admin' && resource.type === 'tenant') || principal.actor.id === 'ada';
      return {
        allowed,
        reason: allowed ? 'test: granted' : 'test: not a tenant admin',
        evidence: { action, relation: '', resource: resource.id, actorSubject: principal.actor.id },
      };
    },
    checkBatch: async () => [],
  },
} as const;

const sessionStore = {
  create: async () => ({ sessionId: 'ses' as never, expiresAt: NOW }),
  get: async () => null,
  list: async () => ({ data: [] }),
  revoke: async () => ({ revoked: false }),
  revokeAllForUser: async () => ({ revokedCount: 0 }),
  revokeByProvider: async () => ({ revokedCount: 0 }),
};

function makeApp(
  options: {
    enroll?: SiteEnrollOutcome;
    signIn?: SiteSignInOutcome;
    clientAddress?: false;
    /** What `restorePerson` answers; `absent` for a binding without it. */
    restore?: SitePersonRestoreOutcome | 'absent';
  } = {},
) {
  const sites = new Map<string, Site>();
  const calls: Array<{ method: string; input: unknown }> = [];
  const { restore } = options;
  const binding: SiteBinding = {
    async register(input: SiteRegisterInput) {
      calls.push({ method: 'register', input });
      if (input.projectId !== P1) return { kind: 'project-not-found' };
      const site: Site = {
        siteId: randomUUID(),
        tenantId: input.tenantId,
        projectId: input.projectId,
        displayName: input.displayName,
        origin: input.origin,
        approvalsUrl: input.approvalsUrl,
        allowedRoles: input.allowedRoles ?? [],
        roleMap: input.roleMap ?? {},
        reviewerCeiling: input.reviewerCeiling ?? 'standard',
        vouching: input.vouching ?? true,
        peopleCap: input.peopleCap ?? 50,
        newPeoplePerDay: input.newPeoplePerDay ?? 20,
        keys: [],
        createdAt: NOW,
        createdBy: input.by,
      };
      sites.set(site.siteId, site);
      return { kind: 'ok', site, enrollment: { code: 'enroll-once', expiresAt: NOW } };
    },
    list: async () => ({ data: [...sites.values()] }),
    get: async ({ siteId }) => sites.get(siteId) ?? null,
    async update(input) {
      calls.push({ method: 'update', input });
      const { siteId, patch } = input;
      const site = sites.get(siteId);
      if (site === undefined) return { kind: 'not-found' };
      // As the binding does: the change applied to the site as stored.
      const next = { ...site, ...applySiteChange({ ...site }, patch) } as Site;
      sites.set(siteId, next);
      return { kind: 'ok', site: next };
    },
    async setPaused({ siteId, paused }) {
      const site = sites.get(siteId);
      if (site === undefined) return { kind: 'not-found' };
      const { pausedAt: _was, ...rest } = site;
      const next: Site = paused ? { ...site, pausedAt: NOW } : rest;
      sites.set(siteId, next);
      return { kind: 'ok', site: next };
    },
    async unregister({ siteId }) {
      const site = sites.get(siteId);
      if (site === undefined) return { kind: 'not-found' };
      return { kind: 'ok', site: { ...site, unregisteredAt: NOW } };
    },
    newEnrollmentCode: async ({ siteId }) =>
      sites.has(siteId)
        ? { kind: 'ok', enrollment: { code: 'enroll-again', expiresAt: NOW } }
        : { kind: 'not-found' },
    revokeKey: async ({ siteId, kid }) => {
      const site = sites.get(siteId);
      return site === undefined || kid !== 'k1' ? { kind: 'not-found' } : { kind: 'ok', site };
    },
    async enroll(input) {
      calls.push({ method: 'enroll', input });
      return (
        options.enroll ?? { kind: 'ok', siteId: 'site-1', audience: 'https://kindgi.acme.example' }
      );
    },
    ...(restore === 'absent'
      ? {}
      : {
          async restorePerson(input: SitePersonRestoreInput) {
            calls.push({ method: 'restorePerson', input });
            return restore ?? { kind: 'not-found' };
          },
        }),
    async signIn(input) {
      calls.push({ method: 'signIn', input });
      return (
        options.signIn ?? {
          kind: 'ok',
          token: 'kgi_sk_test_site',
          expiresAt: NOW,
          userId: 'jane' as UserId,
          projectId: P1 as ProjectId,
        }
      );
    },
  };

  const resolveToken: TokenResolver = async (token) =>
    token === ADMIN
      ? { tenantId, userId: 'ada' as UserId, scopes: ['tenant-admin'] }
      : token === MEMBER
        ? { tenantId, userId: 'sam' as UserId, scopes: [] }
        : null;

  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as unknown as RunHandlerBinding,
    authz: authz as never,
    sessionStore,
    sites: {
      binding,
      ...(options.clientAddress !== false && { clientAddress: () => '203.0.113.7' }),
    },
  });

  const call = async (
    token: string | undefined,
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
  ) => {
    const res = await app.request(path, {
      method,
      headers: {
        ...(token !== undefined && { authorization: `Bearer ${token}` }),
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await res.text();
    return {
      status: res.status,
      retryAfter: res.headers.get('retry-after'),
      body: (text.length > 0 ? JSON.parse(text) : {}) as Record<string, any>,
    };
  };
  return { app, call, calls };
}

const register = {
  displayName: 'Acme store',
  origin: 'https://acme-store.example',
  approvalsUrl: 'https://acme-store.example/wp-admin/admin.php?page=kindgi&approval={approvalId}',
};

describe('the sites of a project (tenant admins)', () => {
  test('registering gives the site, with the defaults, and its one-time code', async () => {
    const h = makeApp();
    const res = await h.call(ADMIN, 'POST', `/v1/projects/${P1}/sites`, register);
    expect(res.status).toBe(201);
    expect(res.body.enrollment).toEqual({ code: 'enroll-once', expiresAt: NOW });
    expect(res.body.site).toMatchObject({
      displayName: 'Acme store',
      origin: 'https://acme-store.example',
      allowedRoles: ['administrator', 'shop_manager'],
      roleMap: {
        administrator: { ask: true, reviewer: 'standard' },
        shop_manager: { ask: true, reviewer: 'standard' },
      },
      reviewerCeiling: 'standard',
      vouching: true,
      peopleCap: 50,
      newPeoplePerDay: 20,
      keys: [],
    });
    expect(h.calls[0]?.input).toMatchObject({ projectId: P1, by: 'user:ada' });
  });

  test('allowed roles without a role map: the default map keeps the allowed roles only', async () => {
    const h = makeApp();
    const narrowed = await h.call(ADMIN, 'POST', `/v1/projects/${P1}/sites`, {
      ...register,
      allowedRoles: ['shop_manager'],
    });
    expect(narrowed.status).toBe(201);
    expect(narrowed.body.site.roleMap).toEqual({
      shop_manager: { ask: true, reviewer: 'standard' },
    });
    const other = await h.call(ADMIN, 'POST', `/v1/projects/${P1}/sites`, {
      ...register,
      allowedRoles: ['editor'],
    });
    expect(other.status).toBe(201);
    expect(other.body.site.roleMap).toEqual({});
  });

  test('a person who is not a tenant admin is refused, and the binding is never asked', async () => {
    const h = makeApp();
    const res = await h.call(MEMBER, 'POST', `/v1/projects/${P1}/sites`, register);
    expect(res.status).toBe(403);
    expect((await h.call(MEMBER, 'GET', `/v1/projects/${P1}/sites`)).status).toBe(403);
    expect(h.calls).toEqual([]);
  });

  test.each([
    ['an http origin that is not loopback', { origin: 'http://acme-store.example' }, 'origin'],
    ['an origin with a path', { origin: 'https://acme-store.example/shop' }, 'origin'],
    [
      'an approvals URL on an origin that only starts like the site',
      {
        approvalsUrl:
          'https://acme-store.example.attacker.test/wp-admin/admin.php?approval={approvalId}',
      },
      'approvalsUrl',
    ],
    [
      'an approvals URL without the approval',
      { approvalsUrl: 'https://acme-store.example/wp-admin/' },
      'approvalsUrl',
    ],
    [
      'a reviewer role above the ceiling',
      { roleMap: { administrator: { ask: true, reviewer: 'senior' } } },
      'roleMap',
    ],
    [
      'an admin reviewer role',
      { roleMap: { administrator: { ask: true, reviewer: 'admin' } } },
      'roleMap',
    ],
    [
      'a role map over a role that is not allowed',
      { roleMap: { customer: { ask: true } } },
      'roleMap',
    ],
    ['a setting a site has no such thing as', { tenantRole: 'admin' }, 'tenantRole'],
    [
      'a display name with a right-to-left mark',
      { displayName: 'Ada\u200f (admin)' },
      'displayName',
    ],
    ['a display name with a zero-width space', { displayName: 'Ac\u200bme' }, 'displayName'],
    ['a display name with a C1 control', { displayName: 'Acme\u0085store' }, 'displayName'],
    ['a display name with a line separator', { displayName: 'Acme\u2028store' }, 'displayName'],
    ['a display name with a Hangul filler', { displayName: 'Acme\u3164' }, 'displayName'],
    ['a display name with a bidirectional override', { displayName: 'Acme ‮store' }, 'displayName'],
  ])('refuses %s (site-invalid), before the binding is asked', async (_what, change, field) => {
    const h = makeApp();
    const res = await h.call(ADMIN, 'POST', `/v1/projects/${P1}/sites`, { ...register, ...change });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'site-invalid', details: { field } });
    expect(h.calls).toEqual([]);
  });

  test('a senior reviewer is fine under a senior ceiling; http on loopback is fine', async () => {
    const h = makeApp();
    const res = await h.call(ADMIN, 'POST', `/v1/projects/${P1}/sites`, {
      ...register,
      origin: 'http://localhost:18190',
      approvalsUrl: 'http://localhost:18190/wp-admin/admin.php?page=kindgi&approval={approvalId}',
      reviewerCeiling: 'senior',
      roleMap: { administrator: { ask: true, reviewer: 'senior' }, shop_manager: { ask: false } },
    });
    expect(res.status).toBe(201);
    const v6 = await h.call(ADMIN, 'POST', `/v1/projects/${P1}/sites`, {
      ...register,
      origin: 'http://[::1]:18190',
      approvalsUrl: 'http://[::1]:18190/wp-admin/admin.php?page=kindgi&approval={approvalId}',
    });
    expect(v6.status).toBe(201);
  });

  test("a project id that isn't one is a 400; a project that isn't there is a 404", async () => {
    const h = makeApp();
    expect((await h.call(ADMIN, 'POST', '/v1/projects/not-a-uuid/sites', register)).status).toBe(
      400,
    );
    const missing = await h.call(ADMIN, 'POST', `/v1/projects/${randomUUID()}/sites`, register);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('project-not-found');
  });

  test('reads, changes, pauses, resumes, re-enrolls, revokes a key and unregisters', async () => {
    const h = makeApp();
    const siteId = (await h.call(ADMIN, 'POST', `/v1/projects/${P1}/sites`, register)).body.site
      .siteId as string;
    const base = `/v1/projects/${P1}/sites/${siteId}`;
    expect((await h.call(ADMIN, 'GET', `/v1/projects/${P1}/sites`)).body.data).toHaveLength(1);
    expect((await h.call(ADMIN, 'GET', base)).body.siteId).toBe(siteId);
    expect((await h.call(ADMIN, 'PATCH', base, { vouching: false })).body.vouching).toBe(false);
    expect((await h.call(ADMIN, 'POST', `${base}/pause`)).body.pausedAt).toBe(NOW);
    expect((await h.call(ADMIN, 'POST', `${base}/resume`)).body.pausedAt).toBeUndefined();
    const code = await h.call(ADMIN, 'POST', `${base}/enrollment-codes`);
    expect(code.status).toBe(201);
    expect(code.body).toEqual({ code: 'enroll-again', expiresAt: NOW });
    expect((await h.call(ADMIN, 'POST', `${base}/keys/k1/revoke`)).status).toBe(200);
    // A key the site doesn't have: the same code, a message that names the key too.
    const noKey = await h.call(ADMIN, 'POST', `${base}/keys/k-unknown/revoke`);
    expect(noKey.status).toBe(404);
    expect(noKey.body.error).toMatchObject({
      code: 'site-not-found',
      message: 'No site with that id in this project, or no key with that id on the site',
    });
    expect((await h.call(ADMIN, 'POST', `${base}/unregister`)).body.unregisteredAt).toBe(NOW);
    expect(
      (await h.call(ADMIN, 'GET', `/v1/projects/${P1}/sites/${randomUUID()}`)).body.error,
    ).toMatchObject({ code: 'site-not-found', message: 'No site with that id in this project' });
  });
});

describe("letting a site's person removed in Kindgi back in (tenant admins)", () => {
  const SITE = randomUUID();
  const JANE = randomUUID();
  const restore = `/v1/projects/${P1}/sites/${SITE}/people/${JANE}/restore`;
  const jane = {
    userId: JANE as UserId,
    tenantId,
    displayName: 'Jane, via Acme store',
    createdAt: NOW,
  };

  test('the binding gets the site, the person and who asked, and the answer is the person', async () => {
    const h = makeApp({ restore: { kind: 'ok', user: jane } });
    const res = await h.call(ADMIN, 'POST', restore);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: { userId: JANE, tenantId, displayName: 'Jane, via Acme store', createdAt: NOW },
    });
    expect(h.calls).toEqual([
      {
        method: 'restorePerson',
        input: { tenantId, projectId: P1, siteId: SITE, userId: JANE, by: 'user:ada' },
      },
    ]);
  });

  test('a person who is not a tenant admin is refused, and the binding is never asked', async () => {
    const h = makeApp({ restore: { kind: 'ok', user: jane } });
    const res = await h.call(MEMBER, 'POST', restore);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('permission-denied');
    expect(h.calls).toEqual([]);
  });

  test.each([
    ['not-removed', "This person isn't removed: there's nothing to undo"],
    [
      'left',
      'Their site said they left it, and forgot them: if they come back, it signs them in as a new person',
    ],
    [
      'linked-elsewhere',
      "This person also signs in another way (through another site, or the tenant's own sign-in), and letting them back in would let them in there too. Add them again instead, as a new person: with an email, they're invited",
    ],
  ] as const)('refused as %s: a 409 that says why, with the person', async (reason, message) => {
    const h = makeApp({ restore: { kind: 'refused', reason } });
    const res = await h.call(ADMIN, 'POST', restore);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'site-person-restore-refused',
      message,
      details: { reason, userId: JANE },
    });
  });

  test('no such site, or a site with no link to the person: a 404 each, with its own code', async () => {
    const noSite = await makeApp({ restore: { kind: 'not-found' } }).call(ADMIN, 'POST', restore);
    expect(noSite.status).toBe(404);
    expect(noSite.body.error).toMatchObject({
      code: 'site-not-found',
      message: 'No site with that id in this project',
    });
    const noPerson = await makeApp({ restore: { kind: 'person-not-found' } }).call(
      ADMIN,
      'POST',
      restore,
    );
    expect(noPerson.status).toBe(404);
    expect(noPerson.body.error).toMatchObject({
      code: 'site-person-not-found',
      message: 'No person of this site with that id',
      details: { userId: JANE },
    });
  });

  test('a retry with the same Idempotency-Key gets the same answer, and the binding is asked once', async () => {
    const h = makeApp({ restore: { kind: 'ok', user: jane } });
    const post = () =>
      h.app.request(restore, {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN}`, 'idempotency-key': 'restore-jane-1' },
      });
    const first = await post();
    const again = await post();
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(await first.json());
    expect(h.calls.filter((c) => c.method === 'restorePerson')).toHaveLength(1);
  });

  test("a project id that isn't one is a 400, before the binding is asked", async () => {
    const h = makeApp({ restore: { kind: 'ok', user: jane } });
    const res = await h.call(
      ADMIN,
      'POST',
      `/v1/projects/p-1/sites/${SITE}/people/${JANE}/restore`,
    );
    expect(res.status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  test("a binding that can't let people back in: the route isn't there, and the site's others are", async () => {
    const h = makeApp({ restore: 'absent' });
    const res = await h.call(ADMIN, 'POST', restore);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('route-not-found');
    expect((await h.call(ADMIN, 'GET', `/v1/projects/${P1}/sites`)).status).toBe(200);
  });
});

describe('a change is checked as the site it makes', () => {
  const seniorSite = {
    ...register,
    reviewerCeiling: 'senior',
    roleMap: { administrator: { ask: true, reviewer: 'senior' } },
  };

  test.each([
    [
      'an approvals URL alone, on another origin',
      { approvalsUrl: 'https://attacker.test/a?approval={approvalId}' },
      'approvalsUrl',
    ],
    [
      'an origin alone, leaving the approvals URL on the old one',
      { origin: 'https://other-store.example' },
      'approvalsUrl',
    ],
    ['a ceiling below what the role map gives', { reviewerCeiling: 'standard' }, 'roleMap'],
  ])('refuses %s', async (_what, patch, field) => {
    const h = makeApp();
    const siteId = (await h.call(ADMIN, 'POST', `/v1/projects/${P1}/sites`, seniorSite)).body.site
      .siteId as string;
    const res = await h.call(ADMIN, 'PATCH', `/v1/projects/${P1}/sites/${siteId}`, patch);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'site-invalid', details: { field } });
  });

  test('a change that keeps the site whole goes through', async () => {
    const h = makeApp();
    const siteId = (await h.call(ADMIN, 'POST', `/v1/projects/${P1}/sites`, seniorSite)).body.site
      .siteId as string;
    const res = await h.call(ADMIN, 'PATCH', `/v1/projects/${P1}/sites/${siteId}`, {
      origin: 'https://other-store.example',
      approvalsUrl: 'https://other-store.example/wp-admin/admin.php?approval={approvalId}',
    });
    expect(res.status).toBe(200);
    expect(res.body.origin).toBe('https://other-store.example');
  });

  test('allowed roles alone keep the map of the roles still allowed; a map given is checked as given', async () => {
    const h = makeApp();
    const siteId = (await h.call(ADMIN, 'POST', `/v1/projects/${P1}/sites`, register)).body.site
      .siteId as string;
    const url = `/v1/projects/${P1}/sites/${siteId}`;
    const narrowed = await h.call(ADMIN, 'PATCH', url, { allowedRoles: ['shop_manager'] });
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.roleMap).toEqual({ shop_manager: { ask: true, reviewer: 'standard' } });
    // The binding gets the change as sent: it applies it to the site as stored.
    expect(h.calls.at(-1)).toMatchObject({
      method: 'update',
      input: { patch: { allowedRoles: ['shop_manager'] } },
    });
    expect((h.calls.at(-1)?.input as { patch: object }).patch).not.toHaveProperty('roleMap');
    const stray = await h.call(ADMIN, 'PATCH', url, {
      allowedRoles: ['shop_manager'],
      roleMap: { administrator: { ask: true } },
    });
    expect(stray.status).toBe(400);
    expect(stray.body.error).toMatchObject({ code: 'site-invalid', details: { field: 'roleMap' } });
  });
});

describe("createApp refuses sites it can't hold", () => {
  const base = () => ({
    ...createStubAppBindings(),
    resolveToken: async () => null,
    runHandler: {} as unknown as RunHandlerBinding,
    sites: { binding: {} as never },
  });
  test('without authorization', () => {
    expect(() => createApp({ ...base(), sessionStore })).toThrow(/needs authorization/);
  });
  test("without a session store that ends a site's sessions", () => {
    const { revokeByProvider: _gone, ...store } = sessionStore;
    expect(() => createApp({ ...base(), authz: authz as never, sessionStore: store })).toThrow(
      /revokeByProvider/,
    );
    expect(() => createApp({ ...base(), authz: authz as never })).toThrow(/revokeByProvider/);
  });
});

describe('a site enrolls its key (public)', () => {
  const key = {
    kty: 'OKP',
    crv: 'Ed25519',
    x: 'q2x9W1n3tT0eZr8kN5bH7cJ4dF6gA2sL1mP0oQ9vR3u',
    kid: 'k1',
  };

  test('with no bearer token: the code and key go to the binding with the client address', async () => {
    const h = makeApp();
    const res = await h.call(undefined, 'POST', '/v1/auth/sites/enroll', {
      code: 'enroll-once',
      publicKey: key,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ siteId: 'site-1', audience: 'https://kindgi.acme.example' });
    expect(h.calls).toEqual([
      {
        method: 'enroll',
        input: { code: 'enroll-once', publicKey: key, clientAddress: '203.0.113.7' },
      },
    ]);
  });

  test('only the public members go to the binding', async () => {
    const h = makeApp();
    await h.call(undefined, 'POST', '/v1/auth/sites/enroll', {
      code: 'enroll-once',
      publicKey: { ...key, use: 'sig', alg: 'EdDSA' },
    });
    expect((h.calls[0]?.input as { publicKey: unknown }).publicKey).toEqual(key);
  });

  test.each([
    ['a private part', { ...key, d: 'q2x9W1n3tT0eZr8kN5bH7cJ4dF6gA2sL1mP0oQ9vR3u' }, /public half/],
    ['another key type', { ...key, kty: 'EC', crv: 'P-256' }, /Ed25519/],
    ['no kid', { kty: 'OKP', crv: 'Ed25519', x: key.x }, /kid/],
    ['an x that is not 32 bytes', { ...key, x: 'abc' }, /32-byte/],
  ])('refuses a key with %s before any code is looked up', async (_what, publicKey, message) => {
    const h = makeApp();
    const res = await h.call(undefined, 'POST', '/v1/auth/sites/enroll', {
      code: 'enroll-once',
      publicKey,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('site-key-invalid');
    expect(res.body.error.message).toMatch(message);
    expect(h.calls).toEqual([]);
  });

  test.each([
    [{ kind: 'refused' } as const, 401, 'site-enrollment-refused'],
    [{ kind: 'invalid-key', message: 'not Ed25519' } as const, 400, 'site-key-invalid'],
    [{ kind: 'rate-limited', retryAfterSeconds: 30 } as const, 429, 'rate-limit-exceeded'],
  ])('maps %o', async (enroll, status, code) => {
    const h = makeApp({ enroll });
    const res = await h.call(undefined, 'POST', '/v1/auth/sites/enroll', {
      code: 'x',
      publicKey: key,
    });
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    if (status === 429) expect(res.retryAfter).toBe('30');
  });
});

describe('a site signs one of its people in (public)', () => {
  test('a session for the person, named as approvals name them', async () => {
    const h = makeApp();
    const res = await h.call(undefined, 'POST', '/v1/auth/site-sign-in', { statement: STATEMENT });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      token: 'kgi_sk_test_site',
      expiresAt: NOW,
      userId: 'jane',
      actor: 'user:jane',
      projectId: P1,
    });
    expect(h.calls).toEqual([
      { method: 'signIn', input: { statement: STATEMENT, clientAddress: '203.0.113.7' } },
    ]);
  });

  test.each(['malformed', 'unknown-site', 'unknown-key', 'key-retired', 'bad-signature'] as const)(
    'before the signature holds, %s is answered as not-verified, with one message',
    async (reason) => {
      const h = makeApp({ signIn: { kind: 'refused', reason, message: `exact: ${reason}` } });
      const res = await h.call(undefined, 'POST', '/v1/auth/site-sign-in', {
        statement: STATEMENT,
      });
      expect(res.status).toBe(401);
      expect(res.body.error.details).toEqual({ reason: 'not-verified' });
      expect(res.body.error.message).toBe(
        "The statement couldn't be verified: check the site's id, key and signature",
      );
    },
  );

  test("the client's address defaults to the nearest X-Forwarded-For hop", async () => {
    const h = makeApp({ clientAddress: false });
    const res = await h.app.request('/v1/auth/site-sign-in', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.1, 203.0.113.9',
      },
      body: JSON.stringify({ statement: STATEMENT }),
    });
    expect(res.status).toBe(200);
    expect((h.calls[0]?.input as { clientAddress: string }).clientAddress).toBe('203.0.113.9');
  });

  test('a refusal says why, in details.reason', async () => {
    const h = makeApp({
      signIn: { kind: 'refused', reason: 'replayed', message: 'That statement was used.' },
    });
    const res = await h.call(undefined, 'POST', '/v1/auth/site-sign-in', { statement: STATEMENT });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({
      code: 'site-sign-in-refused',
      message: 'That statement was used.',
      details: { reason: 'replayed' },
    });
  });

  test("a body over 4096 bytes, or a statement that isn't a compact JWS, never reaches the binding", async () => {
    const h = makeApp();
    const big = await h.call(undefined, 'POST', '/v1/auth/site-sign-in', {
      statement: `${'a'.repeat(4100)}.b.c`,
    });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('site-request-too-large');
    expect(
      (await h.call(undefined, 'POST', '/v1/auth/site-sign-in', { statement: 'not a jws' })).status,
    ).toBe(400);
    expect((await h.call(undefined, 'POST', '/v1/auth/site-sign-in', '[1,2]')).status).toBe(400);
    expect(h.calls).toEqual([]);
  });
});

test('without a site binding, none of the routes is there', async () => {
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken: async () => ({ tenantId, userId: 'ada' as UserId, scopes: ['tenant-admin'] }),
    runHandler: {} as unknown as RunHandlerBinding,
  });
  const post = (path: string) =>
    app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: '{}',
    });
  expect((await post('/v1/auth/site-sign-in')).status).toBe(404);
  expect((await post('/v1/auth/sites/enroll')).status).toBe(404);
  expect((await post(`/v1/projects/${P1}/sites`)).status).toBe(404);
  // `kindgi exports create` skips the sites on this answer, as a route the server doesn't serve.
  const list = await app.request(`/v1/projects/${P1}/sites`, {
    headers: { authorization: `Bearer ${ADMIN}` },
  });
  expect(list.status).toBe(404);
  expect(((await list.json()) as { error: { code: string } }).error.code).toBe('route-not-found');
});

describe("a person's name, as a site sends it", () => {
  test('loses what can disguise it, and keeps the joiners names and emoji need', async () => {
    const { withoutHiddenCharacters } = await import('../src/index.js');
    expect(withoutHiddenCharacters('Ada‏ (admin)‮')).toBe('Ada (admin)');
    expect(withoutHiddenCharacters(' Ac​me\u0085  ')).toBe('Acme');
    // Persian with a zero-width non-joiner, and an emoji family with joiners.
    expect(withoutHiddenCharacters('می‌را')).toBe('می‌را');
    expect(withoutHiddenCharacters('Sam \u{1f468}‍\u{1f469}‍\u{1f467}')).toBe(
      'Sam \u{1f468}‍\u{1f469}‍\u{1f467}',
    );
  });
});
