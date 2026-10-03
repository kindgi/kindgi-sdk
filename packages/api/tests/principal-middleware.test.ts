// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `principalMiddleware`: a user when the token names one; otherwise a
 * service account (a durable API key's id, else the session id).
 */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import type { ApiTokenId, SessionId, TenantId, UserId } from '@kindgi/types';

import { principalMiddleware } from '../src/middleware/principal.js';
import type { AppEnv } from '../src/types.js';

const tenantId = '00000000-0000-4000-8000-00000000000a' as TenantId;

async function principalFor(vars: {
  userId?: UserId;
  tokenId?: ApiTokenId;
  sessionId?: SessionId;
}): Promise<unknown> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('tenantId', tenantId);
    if (vars.userId !== undefined) c.set('userId', vars.userId);
    if (vars.tokenId !== undefined) c.set('tokenId', vars.tokenId);
    if (vars.sessionId !== undefined) c.set('sessionId', vars.sessionId);
    await next();
  });
  app.use('*', principalMiddleware());
  app.get('/', (c) => c.json({ principal: c.get('principal') ?? null }));
  const res = await app.request('/');
  return ((await res.json()) as { principal: unknown }).principal;
}

describe('principalMiddleware', () => {
  test('an API key is its service account', async () => {
    expect(await principalFor({ tokenId: 'key-1' as ApiTokenId })).toEqual({
      actor: { kind: 'service_account', id: 'key-1', tenantId },
    });
  });

  test('the key id wins over a session id', async () => {
    expect(
      await principalFor({ tokenId: 'key-1' as ApiTokenId, sessionId: 'sess-1' as SessionId }),
    ).toEqual({ actor: { kind: 'service_account', id: 'key-1', tenantId } });
  });

  test('a user wins over both', async () => {
    expect(
      await principalFor({ userId: 'user-1' as UserId, tokenId: 'key-1' as ApiTokenId }),
    ).toEqual({ actor: { kind: 'user', id: 'user-1', tenantId } });
  });

  test('a session without a user is still a service account, as before', async () => {
    expect(await principalFor({ sessionId: 'sess-1' as SessionId })).toEqual({
      actor: { kind: 'service_account', id: 'sess-1', tenantId },
    });
  });

  test('none of them: no principal', async () => {
    expect(await principalFor({})).toBeNull();
  });
});
