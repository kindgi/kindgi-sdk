// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { ApiTokenId, SessionId, TenantId, Timestamp, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { SESSION_TOKEN_PREFIX, createApp } from '../src/index.js';
import type {
  ApiTokenRecord,
  RunHandlerBinding,
  Session,
  SessionStoreBinding,
  TokenAdmin,
  TokenMintInput,
  TokenResolution,
} from '../src/index.js';

/**
 * Minting an API key with a key: the new key may not outlive the key
 * minting it. A session opened by token sign-in mints as the key it was
 * opened with. The deployment's token, a key without an expiry, and a
 * session from any other sign-in cap nothing.
 */

const tenantId = randomUUID() as TenantId;
const alice = 'user-alice' as UserId;
const CONSOLE = 'https://kindgi.example.com';
const HOUR = 60 * 60 * 1000;
/** The deployment's own token: no principal, no expiry. */
const BOOT = 'kgi_boot';

type StoredKey = ApiTokenRecord & { readonly tenantId: TenantId; readonly secret: string };

/** An in-memory TokenAdmin that keeps each key's expiry, and whose keys resolve. */
function makeKeys() {
  const records = new Map<string, StoredKey>();
  const admin: TokenAdmin = {
    async mint(input: TokenMintInput) {
      const tokenId = randomUUID() as ApiTokenId;
      const secret = `kgi_ak_test_${randomBytes(8).toString('hex')}`;
      const record: StoredKey = {
        tokenId,
        tenantId: input.tenantId,
        secret,
        ...(input.principal !== undefined && { principal: input.principal }),
        role: input.role,
        capabilities: input.capabilities,
        ...(input.expiresAt !== undefined && { expiresAt: input.expiresAt }),
        createdAt: new Date(),
      };
      records.set(tokenId, record);
      return { record, token: secret };
    },
    async list({ tenantId: t, limit }) {
      return [...records.values()].filter((r) => r.tenantId === t).slice(0, limit);
    },
    async get({ tenantId: t, tokenId }) {
      const r = records.get(tokenId);
      return r !== undefined && r.tenantId === t ? r : undefined;
    },
    async revoke({ tenantId: t, tokenId }) {
      const r = records.get(tokenId);
      if (r === undefined || r.tenantId !== t) return { kind: 'not-found' };
      records.set(tokenId, { ...r, revokedAt: new Date() });
      return { kind: 'ok' };
    },
  };
  const resolve = async (token: string): Promise<TokenResolution | null> => {
    const r = [...records.values()].find((x) => x.secret === token);
    if (r === undefined) return null;
    return {
      tenantId: r.tenantId,
      tokenId: r.tokenId,
      ...(r.principal?.kind === 'user' && { userId: r.principal.userId as UserId }),
      tokenRole: r.role,
      scopes: r.role === 'admin' ? ['tenant-admin'] : [],
      capabilities: r.capabilities,
      ...(r.expiresAt !== undefined && { expiresAt: r.expiresAt }),
      ...(r.revokedAt !== undefined && { revoked: true }),
    };
  };
  return { admin, resolve, records };
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function makeSessions(): SessionStoreBinding {
  const rows = new Map<string, { session: Session; hash: string }>();
  return {
    async create(input) {
      const id = randomUUID() as unknown as SessionId;
      const token = `${SESSION_TOKEN_PREFIX}${id}.${randomBytes(16).toString('hex')}`;
      rows.set(id, {
        session: {
          id,
          tenantId: input.tenantId,
          userId: input.userId,
          providerId: input.providerId,
          expiresAt: input.expiresAt,
          scopes: input.scopes,
          createdAt: new Date().toISOString() as Timestamp,
        },
        hash: sha(token),
      });
      return { sessionId: id, expiresAt: input.expiresAt, token };
    },
    async resolveToken({ token }) {
      const id = token.slice(SESSION_TOKEN_PREFIX.length).split('.')[0] ?? '';
      const row = rows.get(id);
      return row !== undefined && row.hash === sha(token) ? row.session : null;
    },
    async get({ sessionId }) {
      return rows.get(sessionId)?.session ?? null;
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
  };
}

function makeApp() {
  const keys = makeKeys();
  const sessions = makeSessions();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken: async (token) =>
      token === BOOT ? { tenantId, scopes: ['tenant-admin'] } : keys.resolve(token),
    runHandler: {} as RunHandlerBinding,
    tokenAdmin: keys.admin,
    sessionStore: sessions,
    session: { ttl: 12 * HOUR, cookie: { allowedOrigins: [CONSOLE] }, tokenSignIn: true },
  });
  /** A full key of alice's, expiring at `expiresAt` (or never). */
  const aliceKey = async (expiresAt?: Date) => {
    const minted = await keys.admin.mint({
      tenantId,
      principal: { kind: 'user', userId: alice },
      role: 'admin',
      capabilities: [],
      ...(expiresAt !== undefined && { expiresAt }),
    });
    if (!('token' in minted)) throw new Error(minted.message);
    return minted;
  };
  return { app, keys, sessions, aliceKey };
}

type Answer = {
  status: number;
  body: {
    tokenId?: string;
    expiresAt?: string;
    error?: { code: string; message: string; details?: Record<string, unknown> };
  };
};

const answer = async (res: Response): Promise<Answer> => ({
  status: res.status,
  body: (await res.json()) as Answer['body'],
});

/** `POST /v1/tokens` with a bearer token, minting a key that expires at `expiresAt` (or never). */
const mintWith = async (
  app: ReturnType<typeof createApp>,
  bearer: string,
  expiresAt?: Date,
): Promise<Answer> =>
  answer(
    await app.request('/v1/tokens', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify(expiresAt === undefined ? {} : { expiresAt: expiresAt.toISOString() }),
    }),
  );

/** The console session token sign-in opens with `key`: its cookie. */
const signIn = async (app: ReturnType<typeof createApp>, key: string): Promise<string> => {
  const res = await app.request('/v1/auth/token-sign-in', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
};

/** `POST /v1/tokens` from a console session, by its cookie. */
const mintFromConsole = async (
  app: ReturnType<typeof createApp>,
  cookie: string,
  expiresAt?: Date,
): Promise<Answer> =>
  answer(
    await app.request('/v1/tokens', {
      method: 'POST',
      headers: { cookie, origin: CONSOLE, 'content-type': 'application/json' },
      body: JSON.stringify(expiresAt === undefined ? {} : { expiresAt: expiresAt.toISOString() }),
    }),
  );

const expectOutlives = (res: Answer, minterExpiresAt: Date) => {
  expect(res.status).toBe(403);
  expect(res.body.error?.code).toBe('token-expiry-exceeds-minter');
  expect(res.body.error?.details?.latestExpiresAt).toBe(minterExpiresAt.toISOString());
  expect(res.body.error?.message).toContain(minterExpiresAt.toISOString());
};

describe('POST /v1/tokens: a key minted by a key may not outlive it', () => {
  test('a later expiry is refused, naming the latest allowed, and no key is minted', async () => {
    const { app, keys, aliceKey } = makeApp();
    const minterExpiresAt = new Date(Date.now() + HOUR);
    const minter = await aliceKey(minterExpiresAt);
    const res = await mintWith(app, minter.token, new Date(minterExpiresAt.getTime() + 1));
    expectOutlives(res, minterExpiresAt);
    expect(res.body.error?.message).toMatch(/can't outlive the key minting it/);
    expect(keys.records.size).toBe(1);
  });

  test('no expiry is refused: the new key would never expire', async () => {
    const { app, keys, aliceKey } = makeApp();
    const minterExpiresAt = new Date(Date.now() + HOUR);
    const minter = await aliceKey(minterExpiresAt);
    const res = await mintWith(app, minter.token);
    expectOutlives(res, minterExpiresAt);
    expect(res.body.error?.message).toMatch(/give the new key an `expiresAt`/);
    expect(keys.records.size).toBe(1);
  });

  test.each([
    ['the same expiry', 0],
    ['an earlier one', -10 * 60 * 1000],
  ])('%s is accepted', async (_label, offset) => {
    const { app, aliceKey } = makeApp();
    const minterExpiresAt = new Date(Date.now() + HOUR);
    const minter = await aliceKey(minterExpiresAt);
    const wanted = new Date(minterExpiresAt.getTime() + offset);
    const res = await mintWith(app, minter.token, wanted);
    expect(res.status).toBe(201);
    expect(res.body.expiresAt).toBe(wanted.toISOString());
  });

  test('a key without an expiry caps nothing: its key may have none either', async () => {
    const { app, aliceKey } = makeApp();
    const minter = await aliceKey();
    const res = await mintWith(app, minter.token);
    expect(res.status).toBe(201);
    expect(res.body.expiresAt).toBeUndefined();
  });

  test("the deployment's token caps nothing: it mints a key that never expires", async () => {
    const { app } = makeApp();
    const res = await mintWith(app, BOOT);
    expect(res.status).toBe(201);
    expect(res.body.expiresAt).toBeUndefined();
  });
});

describe('POST /v1/tokens from a session', () => {
  test('a session token sign-in opened mints as its key: no expiry, or a later one, is refused', async () => {
    const { app, keys, aliceKey } = makeApp();
    const minterExpiresAt = new Date(Date.now() + HOUR);
    const minter = await aliceKey(minterExpiresAt);
    const cookie = await signIn(app, minter.token);
    expectOutlives(await mintFromConsole(app, cookie), minterExpiresAt);
    expectOutlives(
      await mintFromConsole(app, cookie, new Date(minterExpiresAt.getTime() + HOUR)),
      minterExpiresAt,
    );
    expect(keys.records.size).toBe(1);
    const within = await mintFromConsole(app, cookie, new Date(minterExpiresAt.getTime() - 1000));
    expect(within.status).toBe(201);
  });

  test("a session token sign-in opened with a key that doesn't expire caps nothing", async () => {
    const { app, aliceKey } = makeApp();
    const minter = await aliceKey();
    const cookie = await signIn(app, minter.token);
    const res = await mintFromConsole(app, cookie);
    expect(res.status).toBe(201);
    expect(res.body.expiresAt).toBeUndefined();
  });

  test.each([
    ['revoked', 'revoke'],
    ['gone', 'delete'],
  ] as const)('its key %s since: the mint is refused, 401 auth-revoked', async (_label, how) => {
    const { app, keys, aliceKey } = makeApp();
    const minter = await aliceKey(new Date(Date.now() + HOUR));
    const cookie = await signIn(app, minter.token);
    if (how === 'revoke') {
      await keys.admin.revoke({ tenantId, tokenId: minter.record.tokenId });
    } else {
      keys.records.delete(minter.record.tokenId);
    }
    const res = await mintFromConsole(app, cookie, new Date(Date.now() + 60 * 1000));
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('auth-revoked');
  });

  test.each(['oidc-acme', 'email-link'])(
    'a session from another sign-in (%s) is unchanged: a key with no expiry',
    async (providerId) => {
      const { app, sessions } = makeApp();
      const session = await sessions.create({
        tenantId,
        userId: alice,
        providerId,
        expiresAt: new Date(Date.now() + HOUR).toISOString() as Timestamp,
        scopes: [],
      });
      const res = await mintWith(app, session.token as string);
      expect(res.status).toBe(201);
      expect(res.body.expiresAt).toBeUndefined();
    },
  );
});
