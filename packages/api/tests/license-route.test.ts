// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/license`: where the deployment's license key stands, read on
 * each request from the binding the deployment gives (the days left move);
 * not mounted without one. The license is the deployment's: its own token
 * (`kindgi:system`) reads all of it; where the deployment serves exactly
 * one tenant, that tenant's admins read the countdown, never whose key it
 * is or where it's kept; anyone else is refused, and the refusal recorded.
 * `PUT /v1/license` hands the running server a renewed key, for its own
 * token alone.
 */

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { TenantId, UserId } from '@kindgi/types';

import {
  type LicenseKeyRefusal,
  type LicenseReplaced,
  type LicenseStatus,
  type LicenseStatusBinding,
  type LicenseUsage,
  type TokenResolver,
  createApp,
} from '../src/index.js';
import { createStubAppBindings } from '../src/testing/index.js';

import { validateAgainst } from './support/openapi-schema.js';

const TENANT = 't-1' as TenantId;
const OTHER_TENANT = 't-2' as TenantId;
/** The deployment's own token. */
const SYSTEM = 'license-route-system';
/** A tenant admin's key (the authorizer, when there is one, says who's an admin). */
const ADMIN = 'license-route-admin';
const MEMBER = 'license-route-member';
/** An admin of another tenant of the same deployment. */
const OTHER_ADMIN = 'license-route-other-admin';

const resolveToken: TokenResolver = async (token) => {
  if (token === SYSTEM) {
    return { tenantId: TENANT, userId: 'u-sys' as UserId, capabilities: ['kindgi:system'] };
  }
  if (token === ADMIN) return { tenantId: TENANT, userId: 'u-admin' as UserId, capabilities: [] };
  if (token === MEMBER) return { tenantId: TENANT, userId: 'u-member' as UserId };
  if (token === OTHER_ADMIN) return { tenantId: OTHER_TENANT, userId: 'u-other' as UserId };
  return null;
};

/** Where this deployment keeps its key and renewer: never for anyone but its own token. */
const KEY_REF = 'gcp:projects/acme-prod/secrets/kindgi-license-key';
const RENEWER_REF = 'gcp:projects/acme-prod/secrets/kindgi-license-renewer';
const NAME = 'acme.example';

const expiring = (daysLeft: number): LicenseStatus => ({
  mode: 'licensed',
  name: NAME,
  use: 'non-production',
  expiresAt: '2026-11-20T00:00:00.000Z',
  startsUntil: '2026-12-04T00:00:00.000Z',
  daysLeft,
  standing: daysLeft <= 30 ? 'expiring' : 'valid',
  renewBy: 'command',
  ...(daysLeft <= 30 && {
    renew: `from this deployment (kindgi license renew --key ${KEY_REF} --renewer ${RENEWER_REF}), or sign in at https://access.kindgi.com`,
  }),
});

const decision = (allowed: boolean, action: Action, r: ResourceRef): Decision => ({
  allowed,
  ...(!allowed && { failing: 'actor' as const }),
  reason: allowed ? 'test: granted' : 'test: refused',
  evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
});

interface Recorded {
  readonly action: Action;
  readonly resource: string;
  readonly decision: Decision;
}

/**
 * The app with a license binding. With `authz`, an authorizer that makes
 * `u-admin` and `u-other` admins of their tenants and records what's
 * refused; without it, every caller of the tenant passes the admin check,
 * as for every tenant setting there.
 */
function makeApp(
  license: LicenseStatusBinding | undefined,
  options: { readonly authz?: boolean } = {},
) {
  const recorded: Recorded[] = [];
  const admins = new Set(['u-admin', 'u-other', 'u-sys']);
  const authzCheckBinding: AuthzCheckBinding = {
    check: async (p, action, r) =>
      decision(action !== 'admin' || admins.has(p.actor.id), action, r),
    checkBatch: async (p, action, rs) =>
      rs.map((r) => decision(action !== 'admin' || admins.has(p.actor.id), action, r)),
    inProject: async () => true,
    recordDecision: (_p, action, r, d) => {
      recorded.push({ action, resource: `${r.type}:${r.id}`, decision: d });
    },
  };
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as never,
    // So `GET /v1/identity/me/permissions` answers (`licenseOperatorOnly`).
    myAccess: { read: async () => ({ projects: [], orgs: [], teams: [], capabilities: {} }) },
    ...(license !== undefined && { license }),
    ...(options.authz === true && {
      authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
    }),
  });
  const get = async (token?: string, path = '/v1/license') => {
    const res = await app.request(
      path,
      token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
    );
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Not JSON (a 404 from no route): the status says it.
    }
    return { status: res.status, text, body };
  };
  /** `PUT /v1/license` with `body`, sent as it is when it's a string. */
  const put = async (token: string | undefined, body: unknown) => {
    const res = await app.request('/v1/license', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        ...(token !== undefined && { authorization: `Bearer ${token}` }),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Not JSON: the status says it.
    }
    return { status: res.status, text, body: parsed };
  };
  return { get, put, recorded };
}

/** A preview build 70 days after its release: 20 days left to start. */
const PREVIEW = {
  version: '0.1.8',
  releasedAt: '2026-10-20T14:00:00.000Z',
  expiresAt: '2027-01-18T14:00:00.000Z',
  daysLeft: 20,
  standing: 'expiring',
} as const;

/** The countdown a tenant admin reads: these fields, and only these. */
const ADMIN_FIELDS = ['daysLeft', 'expiresAt', 'mode', 'renewBy', 'standing', 'startsUntil'];

/** Neither whose key it is nor where the deployment keeps it. */
function expectNothingOfTheOperators(answer: { text: string; body: Record<string, unknown> }) {
  for (const field of ['name', 'use', 'renew']) expect(answer.body).not.toHaveProperty(field);
  expect(answer.text).not.toContain(NAME);
  expect(answer.text).not.toContain(KEY_REF);
  expect(answer.text).not.toContain(RENEWER_REF);
  expect(answer.text).not.toContain('acme-prod');
}

describe("GET /v1/license: the deployment's own token", () => {
  test('reads all of it, worked out on each request', async () => {
    let daysLeft = 31;
    const { get } = makeApp({ status: () => expiring(daysLeft) });
    const first = await get(SYSTEM);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      mode: 'licensed',
      name: NAME,
      use: 'non-production',
      expiresAt: '2026-11-20T00:00:00.000Z',
      startsUntil: '2026-12-04T00:00:00.000Z',
      daysLeft: 31,
      standing: 'valid',
      renewBy: 'command',
    });
    daysLeft = 30;
    const second = await get(SYSTEM);
    expect(second.body).toMatchObject({ daysLeft: 30, standing: 'expiring' });
    expect(second.body.renew).toContain(`--key ${KEY_REF} --renewer ${RENEWER_REF}`);
  });

  test('nothing outside the schema: a field the binding adds stays out', async () => {
    const { get } = makeApp({
      status: () => ({ ...expiring(12), licensee: 'Acme Corp' }) as LicenseStatus,
    });
    const answer = await get(SYSTEM);
    expect(Object.keys(answer.body).sort()).toEqual(
      [...ADMIN_FIELDS, 'name', 'renew', 'use'].sort(),
    );
    expect(answer.text).not.toContain('Acme Corp');
  });

  test('on a deployment serving several tenants too', async () => {
    const { get } = makeApp(
      { status: () => expiring(10), soleTenant: () => null },
      { authz: true },
    );
    const answer = await get(SYSTEM);
    expect(answer.status).toBe(200);
    expect(answer.body.renew).toContain(KEY_REF);
  });

  test('development: the mode alone', async () => {
    const { get } = makeApp({ status: () => ({ mode: 'development' }) });
    expect((await get(SYSTEM)).body).toEqual({ mode: 'development' });
  });

  test("a preview build's own expiry, in either mode, and only its named fields", async () => {
    for (const status of [{ mode: 'development' as const }, expiring(200)]) {
      const { get } = makeApp({
        status: () =>
          ({ ...status, preview: { ...PREVIEW, stamp: 'from the build' } }) as LicenseStatus,
      });
      const answer = await get(SYSTEM);
      expect(answer.body.preview).toEqual(PREVIEW);
      expect(answer.text).not.toContain('from the build');
      expect(validateAgainst('LicenseStatus', answer.body)).toEqual([]);
    }
  });
});

describe('GET /v1/license: the admins of the one tenant a deployment serves', () => {
  test.each([
    ['without an authorizer: any caller of the tenant', false, MEMBER],
    ["with one: the tenant's admin", true, ADMIN],
  ])('%s reads the countdown, nothing of the operator’s', async (_what, authz, token) => {
    const { get, recorded } = makeApp(
      { status: () => expiring(12), soleTenant: () => TENANT },
      { authz },
    );
    const answer = await get(token);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      mode: 'licensed',
      expiresAt: '2026-11-20T00:00:00.000Z',
      startsUntil: '2026-12-04T00:00:00.000Z',
      daysLeft: 12,
      standing: 'expiring',
      renewBy: 'command',
    });
    expect(Object.keys(answer.body).sort()).toEqual(ADMIN_FIELDS);
    expectNothingOfTheOperators(answer);
    expect(recorded).toEqual([]);
  });

  test('a field the binding adds stays the operator’s', async () => {
    const { get } = makeApp({
      status: () => ({ ...expiring(12), licensee: 'Acme Corp' }) as LicenseStatus,
      soleTenant: () => TENANT,
    });
    const answer = await get(MEMBER);
    expect(Object.keys(answer.body).sort()).toEqual(ADMIN_FIELDS);
    expect(answer.text).not.toContain('Acme Corp');
  });

  test('development: the mode alone', async () => {
    const { get } = makeApp({ status: () => ({ mode: 'development' }), soleTenant: () => TENANT });
    expect((await get(MEMBER)).body).toEqual({ mode: 'development' });
  });

  test("a preview build's own expiry too: it's the build's, not the key's", async () => {
    const { get } = makeApp({
      status: () => ({ ...expiring(12), preview: PREVIEW }),
      soleTenant: () => TENANT,
    });
    const answer = await get(MEMBER);
    expect(answer.body.preview).toEqual(PREVIEW);
    expect(Object.keys(answer.body).sort()).toEqual([...ADMIN_FIELDS, 'preview'].sort());
    expectNothingOfTheOperators(answer);
    expect(validateAgainst('LicenseStatus', answer.body)).toEqual([]);
  });
});

describe('GET /v1/license: everyone else is refused, and the refusal recorded', () => {
  /** What the caller reads, in the answer and in its access audit: plain words, no setting's name. */
  const LICENSE_REFUSAL =
    "Only this deployment's operator reads its license: with the deployment's own token, or a system key holding system:license. A tenant admin reads the license's countdown only where the deployment serves that one tenant.";
  const refusal = { code: 'license-operator-only', message: LICENSE_REFUSAL };

  test('a caller of the one tenant who is not its admin', async () => {
    const { get, recorded } = makeApp(
      { status: () => expiring(12), soleTenant: () => TENANT },
      { authz: true },
    );
    const answer = await get(MEMBER);
    expect(answer.status).toBe(403);
    expect(answer.body.error).toMatchObject(refusal);
    expectNothingOfTheOperators(answer);
    expect(answer.text).not.toContain('2026-11-20');
    expect(recorded).toEqual([
      {
        action: 'read',
        resource: 'tenant:t-1',
        decision: expect.objectContaining({
          allowed: false,
          failing: 'actor',
          reason: LICENSE_REFUSAL,
        }),
      },
    ]);
  });

  test('a tenant admin, once a second tenant appears', async () => {
    let tenants: readonly TenantId[] = [TENANT];
    const { get, recorded } = makeApp(
      {
        status: () => expiring(12),
        soleTenant: () => (tenants.length === 1 ? (tenants[0] ?? null) : null),
      },
      { authz: true },
    );
    expect((await get(ADMIN)).status).toBe(200);
    tenants = [TENANT, OTHER_TENANT];
    const answer = await get(ADMIN);
    expect(answer.status).toBe(403);
    expect(answer.body.error).toMatchObject(refusal);
    expectNothingOfTheOperators(answer);
    expect(recorded).toEqual([
      {
        action: 'read',
        resource: 'tenant:t-1',
        decision: expect.objectContaining({ allowed: false, failing: 'scope' }),
      },
    ]);
  });

  test("an admin of a tenant that isn't the one served", async () => {
    const { get } = makeApp(
      { status: () => expiring(12), soleTenant: () => TENANT },
      { authz: true },
    );
    const answer = await get(OTHER_ADMIN);
    expect(answer.status).toBe(403);
    expect(answer.body.error).toMatchObject(refusal);
  });

  test("a tenant admin, when the deployment doesn't say it serves one tenant", async () => {
    const { get } = makeApp({ status: () => expiring(12) });
    const answer = await get(MEMBER);
    expect(answer.status).toBe(403);
    expect(answer.body.error).toMatchObject(refusal);
    expectNothingOfTheOperators(answer);
  });
});

describe('GET /v1/identity/me/permissions says what GET /v1/license does (licenseOperatorOnly)', () => {
  const tokens = { SYSTEM, ADMIN, OTHER_ADMIN } as const;
  type Caller = keyof typeof tokens;
  // true: the route refuses the caller whatever its role; false: it reads it.
  const cases: readonly (readonly [
    string,
    LicenseStatusBinding['soleTenant'],
    Readonly<Record<Caller, boolean>>,
  ])[] = [
    ['serving the one tenant', () => TENANT, { SYSTEM: false, ADMIN: false, OTHER_ADMIN: true }],
    [
      'serving another tenant alone',
      () => OTHER_TENANT,
      { SYSTEM: false, ADMIN: true, OTHER_ADMIN: false },
    ],
    ['serving several', () => null, { SYSTEM: false, ADMIN: true, OTHER_ADMIN: true }],
    ["that doesn't say", undefined, { SYSTEM: false, ADMIN: true, OTHER_ADMIN: true }],
  ];
  test.each(cases)('a deployment %s', async (_how, soleTenant, operatorOnly) => {
    const { get } = makeApp(
      { status: () => expiring(12), ...(soleTenant !== undefined && { soleTenant }) },
      { authz: true },
    );
    for (const [who, token] of Object.entries(tokens)) {
      const expected = operatorOnly[who as Caller];
      const mine = await get(token, '/v1/identity/me/permissions');
      expect(mine.body.licenseOperatorOnly, who).toBe(expected);
      expect((await get(token)).status, who).toBe(expected ? 403 : 200);
    }
  });
});

test('signed in only; not mounted without a binding', async () => {
  expect((await makeApp({ status: () => ({ mode: 'development' }) }).get()).status).toBe(401);
  expect((await makeApp(undefined).get(SYSTEM)).status).toBe(404);
});

describe("GET /v1/license/usage: the deployment's use, for its key's renewal", () => {
  const USAGE: LicenseUsage = {
    since: '2026-10-05T12:00:00.000Z',
    until: '2026-10-25T12:00:00.000Z',
    runtimeVersion: '0.1.8',
    runs: 1200,
    people: 4,
  };
  /** A binding that counts, recording the periods it was asked for. */
  const counting = (usage: Partial<LicenseUsage> & Record<string, unknown> = {}) => {
    const periods: { since: Date; until: Date }[] = [];
    const binding: LicenseStatusBinding = {
      status: () => expiring(31),
      usage: async (period) => {
        periods.push(period);
        return { ...USAGE, ...usage } as LicenseUsage;
      },
    };
    return { binding, periods };
  };
  const SINCE = '/v1/license/usage?since=2026-10-05T12:00:00Z';

  test("the deployment's own token reads the counts for the period it asks, until now", async () => {
    const { binding, periods } = counting({ projectsInProduction: 1 });
    const before = Date.now();
    const answer = await makeApp(binding).get(SYSTEM, SINCE);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ ...USAGE, projectsInProduction: 1 });
    expect(periods).toHaveLength(1);
    expect(periods[0]?.since.toISOString()).toBe('2026-10-05T12:00:00.000Z');
    expect(periods[0]?.until.getTime()).toBeGreaterThanOrEqual(before);
  });

  test('nothing outside the schema: a field the binding adds stays out', async () => {
    const { binding } = counting({ tenants: ['acme'], projectIds: ['p-1'] });
    const answer = await makeApp(binding).get(SYSTEM, SINCE);
    expect(answer.body).toEqual(USAGE);
    expect(answer.text).not.toContain('acme');
  });

  test('a time with an offset: the same instant', async () => {
    const { binding, periods } = counting();
    const answer = await makeApp(binding).get(
      SYSTEM,
      `/v1/license/usage?since=${encodeURIComponent('2026-10-05T14:00:00+02:00')}`,
    );
    expect(answer.status).toBe(200);
    expect(periods[0]?.since.toISOString()).toBe('2026-10-05T12:00:00.000Z');
  });

  test("up to five minutes ahead of the runtime's clock: taken as now, an empty period", async () => {
    const { binding, periods } = counting();
    const ahead = new Date(Date.now() + 2 * 60_000).toISOString();
    const answer = await makeApp(binding).get(SYSTEM, `/v1/license/usage?since=${ahead}`);
    expect(answer.status).toBe(200);
    expect(periods).toHaveLength(1);
    expect(periods[0]?.since.getTime()).toBe(periods[0]?.until.getTime());
  });

  test('a period that is missing, not a time with a zone, or more than five minutes ahead: 400, nothing counted', async () => {
    const { binding, periods } = counting();
    const app = makeApp(binding);
    for (const query of [
      '',
      '?since=',
      '?since=yesterday',
      '?since=2026-10-05',
      '?since=2026-10-05T12:00:00',
      `?since=${new Date(Date.now() + 6 * 60_000).toISOString()}`,
      `?since=${new Date(Date.now() + 86_400_000).toISOString()}`,
    ]) {
      const answer = await app.get(SYSTEM, `/v1/license/usage${query}`);
      expect(answer.status, query).toBe(400);
      expect((answer.body.error as { code?: string } | undefined)?.code ?? answer.body.code).toBe(
        'bad-input',
      );
    }
    expect(periods).toHaveLength(0);
  });

  test("anyone but the deployment's own token is refused, the refusal recorded, even the one tenant's admin", async () => {
    const { binding, periods } = counting();
    const soleTenant: LicenseStatusBinding = { ...binding, soleTenant: () => TENANT };
    const app = makeApp(soleTenant, { authz: true });
    for (const token of [ADMIN, MEMBER, OTHER_ADMIN]) {
      const answer = await app.get(token, SINCE);
      expect(answer.status, token).toBe(403);
      expect(answer.body.error, token).toMatchObject({
        code: 'license-operator-only',
        message:
          "The deployment's use counts every tenant's: only its operator reads it, with the deployment's own token or a system key holding system:license.",
      });
    }
    // Each refusal recorded once, against the caller's own tenant.
    const refusedRead = (tenant: string) => ({
      action: 'read',
      resource: `tenant:${tenant}`,
      decision: expect.objectContaining({
        allowed: false,
        failing: 'scope',
        reason:
          "The deployment's use counts every tenant's: only its operator reads it, with the deployment's own token or a system key holding system:license.",
      }),
    });
    expect(app.recorded).toEqual([refusedRead('t-1'), refusedRead('t-1'), refusedRead('t-2')]);
    expect(periods).toHaveLength(0);
  });

  test('signed in only', async () => {
    const { binding, periods } = counting();
    expect((await makeApp(binding).get(undefined, SINCE)).status).toBe(401);
    expect(periods).toHaveLength(0);
  });

  test("a deployment that doesn't count: 404, as with no license binding", async () => {
    expect((await makeApp({ status: () => expiring(31) }).get(SYSTEM, SINCE)).status).toBe(404);
    expect((await makeApp(undefined).get(SYSTEM, SINCE)).status).toBe(404);
  });
});

describe('limits: what the key limits, for the operator alone', () => {
  const LIMITS = {
    flows: { plan: 3, most: 4, inUse: 2 },
    agents: { plan: 10, most: 12, inUse: 11 },
  };
  const limited = (): LicenseStatus => ({ ...expiring(31), use: 'production', limits: LIMITS });

  test("the deployment's own token reads them, named field by field", async () => {
    const { get } = makeApp({
      status: () =>
        ({
          ...limited(),
          limits: { flows: { ...LIMITS.flows, tenants: 2 }, agents: LIMITS.agents, runs: {} },
        }) as unknown as LicenseStatus,
    });
    const answer = await get(SYSTEM);
    expect(answer.body.limits).toEqual(LIMITS);
    expect(validateAgainst('LicenseStatus', answer.body)).toEqual([]);
  });

  test('a key that limits one count: that one only', async () => {
    const { get } = makeApp({
      status: () => ({ ...limited(), limits: { agents: LIMITS.agents } }),
    });
    expect((await get(SYSTEM)).body.limits).toEqual({ agents: LIMITS.agents });
  });

  test("the one tenant's admins never read them", async () => {
    const { get } = makeApp({ status: limited, soleTenant: () => TENANT }, { authz: true });
    const answer = await get(ADMIN);
    expect(answer.status).toBe(200);
    expect(answer.body).not.toHaveProperty('limits');
  });
});

describe('PUT /v1/license: a renewed key handed to the running server', () => {
  const KEY = 'kgi_lk_eyJ2IjoxfQ.c2lnbmF0dXJl';
  /** A binding that takes keys, or refuses them with `refusal`, recording each it was handed. */
  const taking = (refusal?: LicenseKeyRefusal) => {
    const handed: string[] = [];
    let status = expiring(5);
    const binding: LicenseStatusBinding = {
      status: () => status,
      replace: async (key): Promise<LicenseReplaced> => {
        handed.push(key);
        if (refusal !== undefined) return { kind: 'refused', reason: refusal };
        status = expiring(40);
        return { kind: 'taken' };
      },
    };
    return { binding, handed };
  };

  test("the deployment's own token hands it a key: checked by the binding, answered with the status it then has", async () => {
    const { binding, handed } = taking();
    const answer = await makeApp(binding).put(SYSTEM, { key: `  ${KEY}\n` });
    expect(answer.status).toBe(200);
    expect(handed).toEqual([KEY]);
    expect(answer.body).toMatchObject({ daysLeft: 40, standing: 'valid', name: NAME });
    expect(validateAgainst('LicenseStatus', answer.body)).toEqual([]);
  });

  test('a key it refuses: 409 license-key-refused, with the reason and its words; it runs on with its own', async () => {
    const reasons: readonly LicenseKeyRefusal[] = [
      'malformed',
      'unknown-key',
      'bad-signature',
      'not-yet-valid',
      'expired',
      'other-licensee',
      'other-use',
      'older',
    ];
    for (const reason of reasons) {
      const { binding } = taking(reason);
      const app = makeApp(binding);
      const answer = await app.put(SYSTEM, { key: KEY });
      expect(answer.status, reason).toBe(409);
      expect(answer.body.error, reason).toMatchObject({
        code: 'license-key-refused',
        details: { reason },
      });
      expect((answer.body.error as { message: string }).message, reason).not.toBe('');
      expect((await app.get(SYSTEM)).body.daysLeft, reason).toBe(5);
    }
  });

  test("a body that isn't { key }: 400, and the binding is never handed anything", async () => {
    const { binding, handed } = taking();
    const app = makeApp(binding);
    for (const body of [
      'not json',
      '[]',
      'null',
      {},
      { key: 1 },
      { key: '' },
      { key: '   ' },
      { key: KEY, use: 'production' },
      { key: 'k'.repeat(4097) },
    ]) {
      const answer = await app.put(SYSTEM, body);
      expect(answer.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect((answer.body.error as { code?: string }).code).toBe('bad-input');
    }
    expect(handed).toEqual([]);
  });

  test("anyone but the deployment's own token is refused, the refusal recorded, even the one tenant's admin", async () => {
    const { binding, handed } = taking();
    const app = makeApp({ ...binding, soleTenant: () => TENANT }, { authz: true });
    for (const token of [ADMIN, MEMBER, OTHER_ADMIN]) {
      const answer = await app.put(token, { key: KEY });
      expect(answer.status, token).toBe(403);
      expect(answer.body.error, token).toMatchObject({
        code: 'license-operator-only',
        message:
          "Only this deployment's operator hands it a license key: with the deployment's own token, or a system key holding system:license.",
      });
    }
    expect(app.recorded.map((r) => [r.action, r.resource, r.decision.allowed])).toEqual([
      ['write', 'tenant:t-1', false],
      ['write', 'tenant:t-1', false],
      ['write', 'tenant:t-2', false],
    ]);
    expect(handed).toEqual([]);
  });

  test('signed in only', async () => {
    const { binding, handed } = taking();
    expect((await makeApp(binding).put(undefined, { key: KEY })).status).toBe(401);
    expect(handed).toEqual([]);
  });

  test("a deployment that doesn't take a key: 404, as with no license binding", async () => {
    expect((await makeApp({ status: () => expiring(31) }).put(SYSTEM, { key: KEY })).status).toBe(
      404,
    );
    expect((await makeApp(undefined).put(SYSTEM, { key: KEY })).status).toBe(404);
  });
});
