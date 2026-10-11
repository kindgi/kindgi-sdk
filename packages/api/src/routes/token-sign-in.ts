// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';

import type { AuditEvent, AuditEventBinding } from '@kindgi/audit-events';
import { ref } from '@kindgi/authz';
import type { Timestamp } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import { encodeSessionToken } from '../middleware/auth.js';
import type { Authorizer } from '../middleware/authorize.js';
import { withholdFromReplay } from '../middleware/idempotency.js';
import type { SessionStoreBinding } from '../session-store-binding.js';
import type { AppEnv } from '../types.js';
import { refused } from './denied.js';

/**
 * `POST /v1/auth/token-sign-in`: a person signs in to the console with an
 * API token. The token comes once, in `Authorization`, and is exchanged for
 * a browser session in the session cookie (HttpOnly, the same as a sign-in
 * with an identity provider), so the browser never keeps it.
 *
 * Only a person's **full** key opens a session. A service account's key is
 * for machines, and a narrowed key (a `member` role, or one project) would
 * be widened to the person's full grants by a session: both are refused,
 * 403 `token-sign-in-not-allowed`. The session acts as the key did: it
 * carries the key's scopes (a deployment without an authorizer reads tenant
 * admin from them; a key's scopes never change after it's minted). It never
 * outlives the key: it ends when the key expires, and, with a store that has
 * `revokeByProvider`, when the key is revoked (its `providerId` is
 * `api-token:<tokenId>`).
 * Refusals are audited (`sign-in-refused`), as is each sign-in. A 403 is
 * also an access decision on a known caller, so it's recorded with the
 * authorizer (`refused`), as every refusal the API decides itself is, and
 * keeps its own code.
 */
export type TokenSignInRouteOptions =
  /** The deployment doesn't allow it, or has no browser sessions: 403 `token-sign-in-off`. */
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly sessionStore: SessionStoreBinding;
      /** The session's lifetime, in milliseconds. */
      readonly ttlMs: number;
      readonly cookieName: string;
      /** Whether the cookie is `Secure`. Default `true` (see `SessionCookieOptions.secure`). */
      readonly cookieSecure?: boolean;
      /** `signed-in` events, best effort. */
      readonly auditEvents?: AuditEventBinding;
    };

export function tokenSignInRouter(
  options: TokenSignInRouteOptions,
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post('/', async (c) => {
    const requestId = c.get('requestId');
    /** An audit event, best effort: a failure is logged, never the answer. */
    const auditEvents = options.enabled ? options.auditEvents : undefined;
    const audit = async (event: Omit<AuditEvent, 'id' | 'timestamp'>) => {
      if (auditEvents === undefined) return;
      try {
        const appended = await auditEvents.append([
          { ...event, id: randomUUID(), timestamp: new Date().toISOString() as Timestamp },
        ]);
        if (appended.kind === 'err') {
          c.get('log').warn(`${event.kind} audit event failed: ${appended.error.message}`);
        }
      } catch (cause) {
        c.get('log').warn(
          `${event.kind} audit event failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    };
    /**
     * The sign-in history's event, then the answer. `failing`, for a 403:
     * it's an access decision too (`read` on the tenant: the console), recorded
     * with the authorizer. `actor` when it's who the caller is, `scope` when
     * it's what their key or the deployment allows.
     */
    const refuse = async (code: string, message: string, failing?: 'actor' | 'scope') => {
      const userId = c.get('userId');
      const serviceAccountId = c.get('serviceAccountId');
      await audit({
        tenantId: c.get('tenantId'),
        kind: 'sign-in-refused',
        actor:
          serviceAccountId !== undefined
            ? `service_account:${serviceAccountId}`
            : userId !== undefined
              ? `user:${userId}`
              : 'system',
        outcome: 'denied',
        payload: { v: 1, doc: { method: 'api-token', reason: code } },
      });
      if (failing !== undefined) {
        return refused(c, authorizer, {
          action: 'read',
          resource: ref('tenant', c.get('tenantId') as unknown as string),
          message,
          failing,
          code,
        });
      }
      c.status(statusFor(code) as never);
      return c.json(toWireError({ code, message }, requestId));
    };

    if (!options.enabled) {
      return refuse(
        'token-sign-in-off',
        "This deployment doesn't allow signing in to the console with an API token. Sign in with your organization's identity provider, or ask whoever runs Kindgi to allow it.",
        'scope',
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
        'actor',
      );
    }
    if (c.get('tokenRole') === 'member' || c.get('tokenProjectId') !== undefined) {
      return refuse(
        'token-sign-in-not-allowed',
        "A narrowed key (a member role, or one project) can't open a console session: the session would carry all of your permissions. Use a full key, or sign in with your identity provider.",
        'scope',
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
      // What the key may do, so the session acts as it did: with authz off,
      // an admin key's `tenant-admin` is how the server and console know.
      scopes: [...(c.get('scopes') ?? [])],
    });
    setCookie(c, options.cookieName, created.token ?? encodeSessionToken(created.sessionId), {
      httpOnly: true,
      secure: options.cookieSecure !== false,
      sameSite: 'Lax',
      path: '/',
      maxAge: Math.max(0, Math.floor((expires - Date.now()) / 1000)),
    });

    await audit({
      tenantId,
      kind: 'signed-in',
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
    });

    // The session is in the cookie, which a stored answer doesn't keep: a
    // repeat with the same Idempotency-Key is refused, not "signed in".
    withholdFromReplay(c);
    return c.json({ userId, expiresAt: new Date(expires).toISOString() });
  });

  return r;
}
