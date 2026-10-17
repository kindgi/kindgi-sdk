// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { SessionId, TenantId, Timestamp, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { SESSION_TOKEN_PREFIX, createApp } from '../src/index.js';
import type {
  IdentityDirectoryBinding,
  RunHandlerBinding,
  SecondFactorBinding,
  SecondFactorProof,
  SecondFactorSettings,
  Session,
  SessionSecondFactor,
  SessionStoreBinding,
  TokenResolver,
} from '../src/index.js';

/**
 * A second factor's routes: the person's own (`/v1/identity/me/second-factor*`,
 * from a session only), a tenant admin's (`/v1/identity/users/:userId/second-factor*`)
 * and the workspace's setting (`/v1/auth/settings`). The binding is a
 * double that answers what each test says and records what it was asked.
 */

const tenantId = randomUUID() as TenantId;
const ALICE = 'u-alice' as UserId;
const BOB = 'u-bob' as UserId;
/** An API key that is Alice's, and a tenant admin key. */
const ALICE_KEY = 'kgi_alice';
const ADMIN_KEY = 'kgi_admin';
const AT = '2026-10-17T00:00:00.000Z' as Timestamp;

type Call = readonly [string, ...unknown[]];

function makeBinding(answers: Partial<Record<keyof SecondFactorBinding, unknown>> = {}) {
  const calls: Call[] = [];
  let settings: SecondFactorSettings = { required: false, onPreviousSecret: 2, unusable: 1 };
  const answer = (name: keyof SecondFactorBinding, fallback: unknown) =>
    name in answers ? answers[name] : fallback;
  const binding: SecondFactorBinding = {
    async status(ref) {
      calls.push(['status', ref]);
      return answer('status', { setUp: false, started: false }) as never;
    },
    async start(ref, proof) {
      calls.push(['start', ref, proof]);
      return answer('start', {
        kind: 'started',
        key: 'JBSWY3DPEHPK3PXP',
        uri: 'otpauth://totp/acme.example:alice?secret=JBSWY3DPEHPK3PXP',
      }) as never;
    },
    async confirm(ref, code) {
      calls.push(['confirm', ref, code]);
      return answer('confirm', { kind: 'confirmed', recoveryCodes: ['aaaaa-bbbbb'] }) as never;
    },
    async newRecoveryCodes(ref, proof) {
      calls.push(['newRecoveryCodes', ref, proof]);
      return answer('newRecoveryCodes', {
        kind: 'replaced',
        recoveryCodes: ['ccccc-ddddd'],
      }) as never;
    },
    async remove(ref, proof) {
      calls.push(['remove', ref, proof]);
      return answer('remove', { kind: 'removed' }) as never;
    },
    async removeFor(ref, by) {
      calls.push(['removeFor', ref, by]);
      return answer('removeFor', true) as never;
    },
    async required(t) {
      calls.push(['required', t]);
      return settings.required;
    },
    async settings(t) {
      calls.push(['settings', t]);
      return settings;
    },
    async setRequired(input) {
      calls.push(['setRequired', input]);
      settings = { ...settings, required: input.required };
      return settings;
    },
  };
  const require = () => {
    settings = { ...settings, required: true };
  };
  return { binding, calls, require };
}

function makeSessions() {
  const sessions = new Map<string, Session>();
  const store = {
    async get({ sessionId }: { sessionId: SessionId }) {
      return sessions.get(sessionId as unknown as string) ?? null;
    },
    async create() {
      throw new Error('not used');
    },
    async list() {
      return { data: [] };
    },
    async revoke() {
      return { revoked: false };
    },
    async revokeAllForUser() {
      return { revokedCount: 0 };
    },
  } as unknown as SessionStoreBinding;
  /** A session for `userId`, its token; `admin` gives it `tenant-admin`. */
  const add = (
    userId: UserId,
    opts: { admin?: boolean; secondFactor?: SessionSecondFactor } = {},
  ): string => {
    const id = `ses-${randomUUID()}` as SessionId;
    sessions.set(id as unknown as string, {
      id,
      tenantId,
      userId,
      providerId: 'email-link',
      expiresAt: '2099-01-01T00:00:00.000Z' as Timestamp,
      scopes: opts.admin === true ? ['tenant-admin'] : [],
      createdAt: AT,
      ...(opts.secondFactor !== undefined && { secondFactor: opts.secondFactor }),
    });
    return `${SESSION_TOKEN_PREFIX}${id as unknown as string}`;
  };
  return { store, add };
}

const directory = {
  async getUser({ userId }: { userId: UserId }) {
    return userId === BOB || userId === ALICE
      ? { userId, tenantId, primaryEmail: `${userId}@acme.example`, createdAt: AT }
      : null;
  },
  async listUsers() {
    return { data: [] };
  },
  async listSessions() {
    return { data: [] };
  },
  async revokeAllSessions({ userId }: { userId: UserId }) {
    return { userId, revokedCount: 0 };
  },
} as unknown as IdentityDirectoryBinding;

const resolveToken: TokenResolver = async (token) => {
  if (token === ALICE_KEY) return { tenantId, userId: ALICE };
  if (token === ADMIN_KEY) return { tenantId, scopes: ['tenant-admin'] };
  return null;
};

function makeApp(answers: Parameters<typeof makeBinding>[0] = {}, mount = true) {
  const sf = makeBinding(answers);
  const sessions = makeSessions();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    identityDirectory: directory,
    sessionStore: sessions.store,
    ...(mount && { secondFactor: sf.binding }),
  });
  const call = (method: string, path: string, token: string, body?: unknown, key?: string) =>
    app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(key !== undefined && { 'idempotency-key': key }),
      },
      ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
  return { app, call, calls: sf.calls, require: sf.require, session: sessions.add };
}

const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string } }).error;
const named = (calls: readonly Call[], name: string) => calls.filter((c) => c[0] === name);
const alice = { tenantId, userId: ALICE };

describe('your own second factor: from a session only', () => {
  test.each([
    ['GET', '/v1/identity/me/second-factor'],
    ['POST', '/v1/identity/me/second-factor'],
    ['POST', '/v1/identity/me/second-factor/confirm'],
    ['POST', '/v1/identity/me/second-factor/recovery-codes'],
    ['POST', '/v1/identity/me/second-factor/remove'],
  ])('%s %s with an API key: 400 auth-not-session-token, the binding not asked', async (m, p) => {
    const t = makeApp();
    const res = await t.call(m, p, ALICE_KEY, m === 'POST' ? { code: '123456' } : undefined);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('auth-not-session-token');
    expect(t.calls).toEqual([]);
  });

  test('GET: yours, and whether the workspace requires one', async () => {
    const t = makeApp({
      status: { setUp: true, since: AT, recoveryCodesLeft: 7, usable: false },
    });
    t.require();
    const res = await t.call('GET', '/v1/identity/me/second-factor', t.session(ALICE));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      setUp: true,
      since: AT,
      recoveryCodesLeft: 7,
      usable: false,
      required: true,
    });
    expect(named(t.calls, 'status')).toEqual([['status', alice]]);
  });

  test('GET: none set up, one started', async () => {
    const t = makeApp({ status: { setUp: false, started: true } });
    const res = await t.call('GET', '/v1/identity/me/second-factor', t.session(ALICE));
    expect(await res.json()).toEqual({ setUp: false, started: true, required: false });
  });
});

describe('setting one up', () => {
  test('start with no body: the key, once, never replayed for its Idempotency-Key', async () => {
    const t = makeApp();
    const token = t.session(ALICE);
    const res = await t.call('POST', '/v1/identity/me/second-factor', token, undefined, 'k1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      key: 'JBSWY3DPEHPK3PXP',
      uri: 'otpauth://totp/acme.example:alice?secret=JBSWY3DPEHPK3PXP',
    });
    expect(named(t.calls, 'start')).toEqual([['start', alice, undefined]]);
    const again = await t.call('POST', '/v1/identity/me/second-factor', token, undefined, 'k1');
    expect(again.status).toBe(409);
    const text = await again.text();
    expect(text).not.toContain('JBSWY3DPEHPK3PXP');
    expect(JSON.parse(text).error.code).toBe('idempotency-key-replay-withheld');
  });

  test('start with {} is a start with no proof', async () => {
    const t = makeApp();
    await t.call('POST', '/v1/identity/me/second-factor', t.session(ALICE), {});
    expect(named(t.calls, 'start')).toEqual([['start', alice, undefined]]);
  });

  test('start with one set up and no proof: 403 second-factor-invalid, saying why', async () => {
    const t = makeApp({ start: { kind: 'proof-needed' } });
    const res = await t.call('POST', '/v1/identity/me/second-factor', t.session(ALICE));
    expect(res.status).toBe(403);
    const error = await errorOf(res);
    expect(error.code).toBe('second-factor-invalid');
    expect(error.message).toMatch(/replace it/);
  });

  test.each<[SecondFactorProof]>([[{ code: '123456' }], [{ recoveryCode: 'aaaaa-bbbbb' }]])(
    'start replacing one with %o: the proof goes to the binding',
    async (proof) => {
      const t = makeApp();
      expect(
        (await t.call('POST', '/v1/identity/me/second-factor', t.session(ALICE), proof)).status,
      ).toBe(200);
      expect(named(t.calls, 'start')).toEqual([['start', alice, proof]]);
    },
  );

  test('confirm: the recovery codes, once, never replayed', async () => {
    const t = makeApp();
    const token = t.session(ALICE);
    const res = await t.call(
      'POST',
      '/v1/identity/me/second-factor/confirm',
      token,
      { code: '123456' },
      'k2',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recoveryCodes: ['aaaaa-bbbbb'] });
    expect(named(t.calls, 'confirm')).toEqual([['confirm', alice, '123456']]);
    const again = await t.call(
      'POST',
      '/v1/identity/me/second-factor/confirm',
      token,
      { code: '123456' },
      'k2',
    );
    expect(await again.text()).not.toContain('aaaaa-bbbbb');
  });

  test('confirm takes a code only: a recovery code is a bad input', async () => {
    const t = makeApp();
    const res = await t.call('POST', '/v1/identity/me/second-factor/confirm', t.session(ALICE), {
      recoveryCode: 'aaaaa-bbbbb',
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('bad-input');
    expect(named(t.calls, 'confirm')).toEqual([]);
  });

  test.each([
    [{ kind: 'not-started' }, 409, 'second-factor-not-started'],
    [{ kind: 'wrong' }, 403, 'second-factor-invalid'],
    [{ kind: 'locked', retryAfterMs: 61_500 }, 429, 'second-factor-locked'],
  ])('confirm answered %o: %i %s', async (outcome, status, code) => {
    const t = makeApp({ confirm: outcome });
    const res = await t.call('POST', '/v1/identity/me/second-factor/confirm', t.session(ALICE), {
      code: '123456',
    });
    expect(res.status).toBe(status);
    expect((await errorOf(res)).code).toBe(code);
    expect(res.headers.get('retry-after')).toBe(status === 429 ? '62' : null);
  });
});

describe('a proof in the body', () => {
  test.each([
    ['nothing', undefined],
    ['not JSON', '{'],
    ['both', { code: '123456', recoveryCode: 'aaaaa-bbbbb' }],
    ['a number', { code: 123456 }],
    ['empty', { code: '' }],
    ['too long', { code: '1'.repeat(65) }],
    ['another field', { pin: '1234' }],
  ])('%s: 400 bad-input, the binding not asked', async (_, body) => {
    const t = makeApp();
    const res = await t.call(
      'POST',
      '/v1/identity/me/second-factor/remove',
      t.session(ALICE),
      body,
    );
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('bad-input');
    expect(named(t.calls, 'remove')).toEqual([]);
  });

  test('64 characters is long enough for one typed with spaces', async () => {
    const t = makeApp();
    const res = await t.call('POST', '/v1/identity/me/second-factor/remove', t.session(ALICE), {
      recoveryCode: 'a'.repeat(64),
    });
    expect(res.status).toBe(200);
  });
});

describe('recovery codes, and taking it off', () => {
  test('new recovery codes: 10 new ones, the proof checked by the binding', async () => {
    const t = makeApp();
    const res = await t.call(
      'POST',
      '/v1/identity/me/second-factor/recovery-codes',
      t.session(ALICE),
      { code: '123456' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recoveryCodes: ['ccccc-ddddd'] });
    expect(named(t.calls, 'newRecoveryCodes')).toEqual([
      ['newRecoveryCodes', alice, { code: '123456' }],
    ]);
  });

  test.each([
    [{ kind: 'not-set-up' }, 409, 'second-factor-not-set-up'],
    [{ kind: 'unusable' }, 403, 'second-factor-unusable'],
    [{ kind: 'wrong' }, 403, 'second-factor-invalid'],
  ])('new recovery codes answered %o: %i %s', async (outcome, status, code) => {
    const t = makeApp({ newRecoveryCodes: outcome });
    const res = await t.call(
      'POST',
      '/v1/identity/me/second-factor/recovery-codes',
      t.session(ALICE),
      { code: '123456' },
    );
    expect(res.status).toBe(status);
    expect((await errorOf(res)).code).toBe(code);
  });

  test('remove: off', async () => {
    const t = makeApp();
    const res = await t.call('POST', '/v1/identity/me/second-factor/remove', t.session(ALICE), {
      recoveryCode: 'aaaaa-bbbbb',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true });
    expect(named(t.calls, 'remove')).toEqual([['remove', alice, { recoveryCode: 'aaaaa-bbbbb' }]]);
  });

  test.each([
    [{ kind: 'required' }, 403, 'second-factor-required'],
    [{ kind: 'not-set-up' }, 409, 'second-factor-not-set-up'],
    [{ kind: 'locked', retryAfterMs: 1 }, 429, 'second-factor-locked'],
  ])('remove answered %o: %i %s', async (outcome, status, code) => {
    const t = makeApp({ remove: outcome });
    const res = await t.call('POST', '/v1/identity/me/second-factor/remove', t.session(ALICE), {
      code: '123456',
    });
    expect(res.status).toBe(status);
    expect((await errorOf(res)).code).toBe(code);
  });
});

describe("a tenant admin and a person's second factor", () => {
  test.each([
    ['GET', '/v1/identity/users/u-bob/second-factor'],
    ['POST', '/v1/identity/users/u-bob/second-factor/remove'],
  ])('%s %s by someone not a tenant admin: 403', async (m, p) => {
    const t = makeApp();
    for (const token of [ALICE_KEY, t.session(ALICE)]) {
      const res = await t.call(m, p, token);
      expect(res.status).toBe(403);
      expect((await errorOf(res)).code).toBe('permission-denied');
    }
    expect(named(t.calls, 'removeFor')).toEqual([]);
    expect(named(t.calls, 'status')).toEqual([]);
  });

  test("reads theirs, and whether it's required", async () => {
    const t = makeApp({ status: { setUp: true, since: AT, recoveryCodesLeft: 10, usable: true } });
    const res = await t.call('GET', '/v1/identity/users/u-bob/second-factor', ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      setUp: true,
      since: AT,
      recoveryCodesLeft: 10,
      usable: true,
      required: false,
    });
    expect(named(t.calls, 'status')).toEqual([['status', { tenantId, userId: BOB }]]);
  });

  test('removes theirs, as who removed it; a session admin is named as themselves', async () => {
    const t = makeApp();
    const res = await t.call('POST', '/v1/identity/users/u-bob/second-factor/remove', ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true });
    const asAlice = t.session(ALICE, { admin: true });
    await t.call('POST', '/v1/identity/users/u-bob/second-factor/remove', asAlice);
    const removals = named(t.calls, 'removeFor');
    expect(removals).toHaveLength(2);
    expect(removals[0]?.[1]).toEqual({ tenantId, userId: BOB });
    expect(removals[0]?.[2]).toMatch(/^(service_account|token):/);
    expect(removals[1]?.[2]).toBe(`user:${ALICE}`);
  });

  test("an admin's own: 403, pointing to /me, and nothing removed", async () => {
    const t = makeApp();
    const res = await t.call(
      'POST',
      `/v1/identity/users/${ALICE}/second-factor/remove`,
      t.session(ALICE, { admin: true }),
    );
    expect(res.status).toBe(403);
    const error = await errorOf(res);
    expect(error.code).toBe('permission-denied');
    expect(error.message).toContain('/v1/identity/me/second-factor/remove');
    expect(named(t.calls, 'removeFor')).toEqual([]);
  });

  test('none to remove: removed false', async () => {
    const t = makeApp({ removeFor: false });
    const res = await t.call('POST', '/v1/identity/users/u-bob/second-factor/remove', ADMIN_KEY);
    expect(await res.json()).toEqual({ removed: false });
  });

  test.each(['GET', 'POST'])("%s for someone the tenant doesn't have: 404", async (m) => {
    const t = makeApp();
    const path = `/v1/identity/users/u-nobody/second-factor${m === 'POST' ? '/remove' : ''}`;
    const res = await t.call(m, path, ADMIN_KEY);
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe('identity-user-not-found');
    expect(named(t.calls, 'removeFor')).toEqual([]);
  });
});

describe('the workspace setting', () => {
  test('a person not a tenant admin: 403, read or change', async () => {
    const t = makeApp();
    expect((await t.call('GET', '/v1/auth/settings', ALICE_KEY)).status).toBe(403);
    const res = await t.call('PATCH', '/v1/auth/settings', t.session(ALICE), {
      secondFactor: { required: true },
    });
    expect(res.status).toBe(403);
    expect(named(t.calls, 'setRequired')).toEqual([]);
  });

  test('GET: required, and the keys on the previous secret or on neither', async () => {
    const t = makeApp();
    const res = await t.call('GET', '/v1/auth/settings', ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      secondFactor: { required: false, onPreviousSecret: 2, unusable: 1 },
    });
  });

  test.each([
    ['nothing', undefined],
    ['not a boolean', { secondFactor: { required: 'yes' } }],
    ['another field', { secondFactor: { required: true }, other: 1 }],
    ['another setting', { secondFactor: { required: true, grace: 1 } }],
  ])('PATCH %s: 400 bad-input', async (_, body) => {
    const t = makeApp();
    const res = await t.call('PATCH', '/v1/auth/settings', ADMIN_KEY, body);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('bad-input');
    expect(named(t.calls, 'setRequired')).toEqual([]);
  });

  test('turned on from a session made without one: 409 enroll-first, nothing changed', async () => {
    const t = makeApp();
    const res = await t.call('PATCH', '/v1/auth/settings', t.session(ALICE, { admin: true }), {
      secondFactor: { required: true },
    });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('second-factor-enroll-first');
    expect(named(t.calls, 'setRequired')).toEqual([]);
  });

  test.each(['totp', 'identity-provider'] as const)(
    'turned on from a session made with one (%s): on, as who did it',
    async (method) => {
      const t = makeApp();
      const token = t.session(ALICE, { admin: true, secondFactor: { method, at: AT } });
      const res = await t.call('PATCH', '/v1/auth/settings', token, {
        secondFactor: { required: true },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        secondFactor: { required: true, onPreviousSecret: 2, unusable: 1 },
      });
      expect(named(t.calls, 'setRequired')).toEqual([
        ['setRequired', { tenantId, required: true, by: `user:${ALICE}` }],
      ]);
    },
  );

  test("turned on with an API key (not a session, so it isn't ended): on", async () => {
    const t = makeApp();
    const res = await t.call('PATCH', '/v1/auth/settings', ADMIN_KEY, {
      secondFactor: { required: true },
    });
    expect(res.status).toBe(200);
  });

  test('turned off from a session made without one: off', async () => {
    const t = makeApp();
    t.require();
    const res = await t.call('PATCH', '/v1/auth/settings', t.session(ALICE, { admin: true }), {
      secondFactor: { required: false },
    });
    expect(res.status).toBe(200);
    expect(named(t.calls, 'setRequired')).toHaveLength(1);
  });
});

test('without a binding, none of these routes is mounted', async () => {
  const t = makeApp({}, false);
  for (const [m, p] of [
    ['GET', '/v1/identity/me/second-factor'],
    ['POST', '/v1/identity/users/u-bob/second-factor/remove'],
    ['GET', '/v1/auth/settings'],
  ] as const) {
    expect((await t.call(m, p, ADMIN_KEY)).status).toBe(404);
  }
});
