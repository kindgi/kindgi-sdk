// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';

import type { AuditEvent, AuditEventBinding } from '@kindgi/audit-events';
import type { Timestamp } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import { encodeSessionToken } from '../middleware/auth.js';
import type { SessionStoreBinding } from '../session-store-binding.js';
import type { AppEnv } from '../types.js';

/**
 * `POST /v1/auth/token-sign-in`: a person signs in to the console with an
 * API token. The token comes once, in `Authorization`, and is exchanged for
 * a browser session in the session cookie (HttpOnly, the same as a sign-in
 * with an identity provider), so the browser never keeps it.
 *
 * Only a person's **full** key opens a session. A service account's key is
 * for machines, and a narrowed key (a `member` role, or one project) would
 * be widened to the person's full grants by a session: both are refused,
 * 403 `token-sign-in-not-allowed`. The session never outlives the key.
 */
export interface TokenSignInRouteOptions {
  readonly sessionStore: SessionStoreBinding;
  /** Whether the deployment allows it; otherwise 403 `token-sign-in-off`. */
  readonly enabled: boolean;
  /** The session's lifetime, in milliseconds. */
  readonly ttlMs: number;
  readonly cookieName: string;
  /** `signed-in` events, best effort. */
  readonly auditEvents?: AuditEventBinding;
}

export function tokenSignInRouter(options: TokenSignInRouteOptions): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post('/', async (c) => {
    const requestId = c.get('requestId');
    const refuse = (code: string, message: string) => {
      c.status(statusFor(code) as never);
      return c.json(toWireError({ code, message }, requestId));
    };

    if (!options.enabled) {
      return refuse(
        'token-sign-in-off',
        "This deployment doesn't allow signing in to the console with an API token. Sign in with your organization's identity provider, or ask whoever runs Kindgi to allow it.",
      );
    }
    if (c.get('sessionId') !== undefined) {
      return refuse(
        'token-sign-in-needs-an-api-token',
        'You are already signed in with a session: token sign-in takes an API token in the Authorization header.',
      );
    }
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    if (c.get('serviceAccountId') !== undefined || userId === undefined) {
      return refuse(
        'token-sign-in-not-allowed',
        "Only a person's API key can open a console session; a service account's key is for machines.",
      );
    }
    if (c.get('tokenRole') === 'member' || c.get('tokenProjectId') !== undefined) {
      return refuse(
        'token-sign-in-not-allowed',
        "A narrowed key (a member role, or one project) can't open a console session: the session would carry all of your permissions. Use a full key, or sign in with your identity provider.",
      );
    }

    const keyExpiresAt = c.get('tokenExpiresAt');
    const expires = Math.min(
      Date.now() + options.ttlMs,
      keyExpiresAt === undefined ? Number.POSITIVE_INFINITY : keyExpiresAt.getTime(),
    );
    const tokenId = c.get('tokenId');
    const created = await options.sessionStore.create({
      tenantId,
      userId,
      providerId: tokenId === undefined ? 'api-token' : `api-token:${tokenId}`,
      expiresAt: new Date(expires).toISOString() as Timestamp,
      scopes: [],
    });
    setCookie(c, options.cookieName, created.token ?? encodeSessionToken(created.sessionId), {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: Math.max(0, Math.floor((expires - Date.now()) / 1000)),
    });

    if (options.auditEvents !== undefined) {
      const event: AuditEvent = {
        id: randomUUID(),
        tenantId,
        kind: 'signed-in',
        timestamp: new Date().toISOString() as Timestamp,
        actor: `user:${userId}`,
        outcome: 'succeeded',
        payload: {
          v: 1,
          doc: {
            method: 'api-token',
            sessionId: created.sessionId,
            ...(tokenId !== undefined && { tokenId }),
          },
        },
      };
      try {
        const appended = await options.auditEvents.append([event]);
        if (appended.kind === 'err') {
          c.get('log').warn(`signed-in audit event failed: ${appended.error.message}`);
        }
      } catch (cause) {
        c.get('log').warn(
          `signed-in audit event failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }

    return c.json({ userId, expiresAt: new Date(expires).toISOString() });
  });

  return r;
}
