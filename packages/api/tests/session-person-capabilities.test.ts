// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A sign-in session carries the capabilities its person holds
 * (`personCapabilities`), read on each request once the session is valid.
 * An API key keeps its own. A system capability is never a person's.
 */

import { describe, expect, test } from 'vitest';

import type { ApiTokenId, SessionId, TenantId, Timestamp, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { SESSION_TOKEN_PREFIX, createApp } from '../src/index.js';
import type {
  ApiTokenRecord,
  MyAccessBinding,
  PersonCapabilitiesBinding,
  RunHandlerBinding,
  Session,
  SessionStoreBinding,
  SigningKeyBinding,
  TokenAdmin,
  TokenResolver,
  TrustedKey,
} from '../src/index.js';

const tenantA = '00000000-0000-4000-8000-00000000000a' as TenantId;
const ALICE = 'user-alice' as UserId;
const BOB = 'user-bob' as UserId;
const FAR = '2099-01-01T00:00:00.000Z' as Timestamp;
const PAST = '2020-01-01T00:00:00.000Z' as Timestamp;
const PUBLIC_KEY = Buffer.alloc(32, 7).toString('base64');
/** An API key acting for Alice, minted with no capabilities. */
const ALICE_KEY = 'kgi_ak_alice_bare';

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
} as unknown as RunHandlerBinding;

/** Sessions by token: `kgi_sk_<name>`. */
function sessionStore(sessions: Record<string, Partial<Session> & { userId: UserId }>) {
  const session = (name: string): Session | null => {
    const s = sessions[name];
    if (s === undefined) return null;
    return {
      id: `session-${name}` as unknown as SessionId,
      tenantId: tenantA,
      providerId: 'acme-sso',
      expiresAt: FAR,
      scopes: [],
      createdAt: '2026-10-01T00:00:00.000Z' as Timestamp,
      ...s,
    };
  };
  const store: SessionStoreBinding = {
    create: async () => {
      throw new Error('unused');
    },
    resolveToken: async ({ token }) => session(token.slice(SESSION_TOKEN_PREFIX.length)),
    get: async () => null,
    list: async () => ({ data: [] }),
    revoke: async () => ({ revoked: false }),
    revokeAllForUser: async () => ({ revokedCount: 0 }),
  };
  return store;
}

/** What each person holds, changeable between requests; every read is logged. */
function personCapabilities(held: Map<UserId, readonly string[]>) {
  const reads: UserId[] = [];
  const binding: PersonCapabilitiesBinding = {
    held: async ({ tenantId, userId }) => {
      reads.push(userId);
      return tenantId === tenantA ? (held.get(userId) ?? []) : [];
    },
  };
  return { binding, reads };
}

function trustList(): SigningKeyBinding {
  const keys = new Map<string, TrustedKey>();
  return {
    isTrusted: async () => ({ kind: 'ok', value: false }),
    verify: async () => ({ kind: 'ok', value: { valid: false, reason: 'unused' } }),
    listTrusted: async () => ({ data: [...keys.values()] }),
    getTrusted: async ({ keyId }) => keys.get(keyId as unknown as string) ?? null,
    async addTrusted({ tenantId, keyId, algorithm, publicKey }) {
      const key: TrustedKey = {
        keyId,
        tenantId,
        algorithm,
        publicKey,
        createdAt: '2026-10-02T00:00:00.000Z',
      };
      keys.set(keyId as unknown as string, key);
      return { kind: 'ok', key };
    },
    revokeTrusted: async () => ({ revoked: false }),
  };
}

function tokenAdmin(): TokenAdmin {
  let seq = 0;
  return {
    async mint(input) {
      seq += 1;
      const record: ApiTokenRecord = {
        tokenId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}` as ApiTokenId,
        role: input.role,
        capabilities: input.capabilities,
        createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, seq)),
      };
      return { record, token: `kgi_ak_minted_${seq}` };
    },
    list: async () => [],
    get: async () => undefined,
    revoke: async () => ({ kind: 'not-found' }),
  };
}

const myAccess: MyAccessBinding = {
  read: async () => ({ projects: [], orgs: [], teams: [], capabilities: {} }),
};

const keyResolver: TokenResolver = async (token) =>
  token === ALICE_KEY ? { tenantId: tenantA, userId: ALICE, scopes: [], capabilities: [] } : null;

function makeApp(held?: Map<UserId, readonly string[]>) {
  const people = held === undefined ? undefined : personCapabilities(held);
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken: keyResolver,
    runHandler,
    sessionStore: sessionStore({
      alice: { userId: ALICE },
      bob: { userId: BOB },
      'alice-revoked': { userId: ALICE, revokedAt: PAST },
      'alice-expired': { userId: ALICE, expiresAt: PAST },
      'alice-idle': { userId: ALICE, lastActiveAt: PAST },
    }),
    session: { inactivityTimeout: 60 * 60 * 1000 },
    signingKeyRegistry: trustList(),
    tokenAdmin: tokenAdmin(),
    myAccess,
    ...(people !== undefined && { personCapabilities: people.binding }),
  });
  return { app, reads: people?.reads ?? [] };
}

async function call(
  app: ReturnType<typeof createApp>,
  method: 'GET' | 'POST',
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const session = (name: string) => `${SESSION_TOKEN_PREFIX}${name}`;
const trust = (app: ReturnType<typeof createApp>, token: string) =>
  call(app, 'POST', '/v1/signing-keys', token, { keyId: 'acme-ci', publicKey: PUBLIC_KEY });
const errorCode = (body: Record<string, unknown>) => (body.error as { code: string }).code;

describe('a sign-in session carries what its person holds', () => {
  test('a person holding signing-keys:write trusts a key; one holding nothing is refused 403', async () => {
    const { app } = makeApp(new Map([[ALICE, ['signing-keys:write']]]));
    expect((await trust(app, session('alice'))).status).toBe(201);
    const refused = await trust(app, session('bob'));
    expect(refused.status).toBe(403);
    expect(errorCode(refused.body)).toBe('permission-denied');
  });

  test('without the binding a session carries none, as before', async () => {
    const { app } = makeApp();
    expect((await trust(app, session('alice'))).status).toBe(403);
    const me = await call(app, 'GET', '/v1/identity/me/permissions', session('alice'));
    expect(me.body.tokenCapabilities).toEqual([]);
  });

  test("the permissions read lists the person's, sorted, with no system capability", async () => {
    const { app } = makeApp(
      new Map([
        [
          ALICE,
          ['signing-keys:write', 'kindgi:system', 'env:write', 'system:tenants', 'secrets:write'],
        ],
      ]),
    );
    const me = await call(app, 'GET', '/v1/identity/me/permissions', session('alice'));
    expect(me.status).toBe(200);
    expect(me.body.tokenCapabilities).toEqual(['env:write', 'secrets:write', 'signing-keys:write']);
  });

  test('read on each request: one taken away is refused on the next', async () => {
    const held = new Map<UserId, readonly string[]>([[ALICE, ['signing-keys:write']]]);
    const { app, reads } = makeApp(held);
    expect((await trust(app, session('alice'))).status).toBe(201);
    held.set(ALICE, []);
    expect((await trust(app, session('alice'))).status).toBe(403);
    expect(reads).toEqual([ALICE, ALICE]);
  });

  test("an API key keeps its own list: its person's aren't added, and aren't read", async () => {
    const { app, reads } = makeApp(new Map([[ALICE, ['signing-keys:write']]]));
    expect((await trust(app, ALICE_KEY)).status).toBe(403);
    expect(reads).toEqual([]);
  });

  test('a revoked, expired or idle session is refused before anything is read', async () => {
    const { app, reads } = makeApp(new Map([[ALICE, ['signing-keys:write']]]));
    expect((await trust(app, session('alice-revoked'))).status).toBe(401);
    expect((await trust(app, session('alice-expired'))).status).toBe(401);
    const idle = await trust(app, session('alice-idle'));
    expect(idle.status).toBe(401);
    expect(errorCode(idle.body)).toBe('session-inactive');
    expect(reads).toEqual([]);
  });

  test('a person puts what they hold on a key they mint, and nothing more', async () => {
    const { app } = makeApp(new Map([[ALICE, ['signing-keys:write', 'secrets:write']]]));
    const minted = await call(app, 'POST', '/v1/tokens', session('alice'), {
      capabilities: ['signing-keys:write'],
    });
    expect(minted.status).toBe(201);
    expect(minted.body).toMatchObject({ role: 'member', capabilities: ['signing-keys:write'] });
    const refused = await call(app, 'POST', '/v1/tokens', session('alice'), {
      capabilities: ['secrets:reveal'],
    });
    expect(refused.status).toBe(403);
    expect((refused.body.error as { message: string }).message).toContain(
      "you don't hold: secrets:reveal",
    );
  });
});
