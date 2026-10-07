// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';
import { Hono } from 'hono';

import type { Cursor, SessionId, TenantId, UserId } from '@kindgi/types';

import { callerPrincipal, callerRef, isTenantAdmin, principalToWire } from '../caller.js';
import { statusFor, toWireError } from '../errors.js';
import type {
  IdentityDirectoryBinding,
  SessionSummary,
  UserRecord,
} from '../identity-directory-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { ReviewerBinding } from '../reviewer-binding.js';
import { callerReviewerRole } from '../reviewer-role.js';
import type { SessionStoreBinding } from '../session-store-binding.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';

/**
 * Identity routes — the canonical caller-identity surface.
 *
 * Hosts the user directory (`/users/*`) and the single canonical
 * `whoami` endpoint, so clients have exactly one whoami endpoint to
 * consume.
 *
 * Six routes:
 *   - `GET  /v1/identity/whoami`                        (self — always mounted)
 *   - `GET  /v1/identity/users`                         (cursor-paginated list)
 *   - `POST /v1/identity/users`                         (add a person; admin, when the directory can)
 *   - `GET  /v1/identity/users/:userId`                 (get)
 *   - `GET  /v1/identity/users/:userId/sessions`        (active sessions)
 *   - `POST /v1/identity/users/:userId/revoke-sessions` (admin op)
 *
 * `directory` is optional: deployments without an `IdentityDirectoryBinding`
 * still get `whoami` (returning the minimal `{ tenantId, scopes, ... }` shape
 * plus `sessionId`/`providerId` if the middleware attached them). When the
 * directory is wired, `whoami` enriches the response with the fuller
 * `UserRecord` and the four `/users/*` routes mount too.
 */
export interface IdentityRouterOptions {
  /**
   * Optional. When present, the `/users/*` routes mount and `whoami`
   * enriches with `UserRecord`. When absent, only `whoami` mounts.
   */
  readonly directory?: IdentityDirectoryBinding;
  /**
   * Optional. When present, `GET /v1/identity/whoami` also returns
   * `expiresAt` for callers on a session token. Absent for
   * deployments that don't wire an OAuth surface.
   */
  readonly sessionStore?: SessionStoreBinding;
  /**
   * Optional. When present, `whoami` reports the reviewer role of a
   * caller whose token carries none from the roster, as the approvals
   * routes resolve it.
   */
  readonly reviewerBinding?: ReviewerBinding;
  /**
   * Optional. Decides who is a tenant admin for `POST /users`; without
   * one, the `tenant-admin` scope does.
   */
  readonly authorizer?: Authorizer;
}

export function identityRouter(options: IdentityRouterOptions = {}): Hono<AppEnv> {
  const { directory, sessionStore, reviewerBinding, authorizer } = options;
  const r = new Hono<AppEnv>();

  // ---------- GET / whoami ----------
  // Mounted first so `/v1/identity/whoami` resolves here rather than
  // being captured by the `:userId` param on subsequent routes.
  r.get('/whoami', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const sessionId = c.get('sessionId') as SessionId | undefined;
    const userId = c.get('userId') as UserId | undefined;
    const providerId = c.get('providerId') as string | undefined;
    const scopes = (c.get('scopes') as readonly string[] | undefined) ?? [];
    const reviewerRole = await callerReviewerRole(c, reviewerBinding);

    const body: Record<string, unknown> = { tenantId };
    if (sessionId !== undefined) body.sessionId = sessionId;
    if (providerId !== undefined) body.providerId = providerId;
    body.scopes = scopes;
    if (reviewerRole !== undefined) body.reviewerRole = reviewerRole;
    Object.assign(body, keyFacts(c));

    if (userId !== undefined) {
      body.userId = userId;
      if (directory !== undefined) {
        const user = await directory.getUser({ tenantId, userId });
        if (user !== null) body.user = serializeUser(user);
      }
    }

    if (sessionId !== undefined && sessionStore !== undefined) {
      const session = await sessionStore.get({ tenantId, sessionId });
      if (session !== null) body.expiresAt = session.expiresAt;
    }
    return c.json(body);
  });

  if (directory === undefined) {
    // Deployments without a directory binding get whoami only.
    // `/users/*` routes fall through to the app-level 404.
    return r;
  }

  // ---------- GET /users (list) ----------
  r.get('/users', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));
    const cursorRaw = c.req.query('cursor');
    const queryRaw = c.req.query('query');

    const page = await directory.listUsers({
      tenantId,
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(queryRaw !== undefined && queryRaw.length > 0 && { query: queryRaw }),
    });
    return c.json({
      data: page.data.map(serializeUser),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- POST /users (add a person; tenant admins) ----------
  const createUser = directory.createUser?.bind(directory);
  if (createUser !== undefined) {
    r.post('/users', async (c) => {
      const requestId = c.get('requestId');
      if (!(await isTenantAdmin(c, authorizer))) {
        c.status(statusFor('permission-denied') as never);
        return c.json(
          toWireError(
            { code: 'permission-denied', message: 'Only a tenant admin adds people' },
            requestId,
          ),
        );
      }
      const parsed = parseCreateUser(await c.req.json().catch(() => undefined));
      if (typeof parsed === 'string') {
        c.status(statusFor('bad-input') as never);
        return c.json(toWireError({ code: 'bad-input', message: parsed }, requestId));
      }
      const createdBy = callerRef(c);
      const outcome = await createUser({
        tenantId: c.get('tenantId') as TenantId,
        ...parsed,
        ...(createdBy !== undefined && { createdBy }),
      });
      if (outcome.kind === 'email-taken') {
        c.status(statusFor('identity-user-email-taken') as never);
        return c.json(
          toWireError(
            {
              code: 'identity-user-email-taken',
              message: 'Another person of this tenant has that email',
              userId: outcome.userId as unknown as string,
            },
            requestId,
          ),
        );
      }
      c.status(201);
      return c.json(serializeUser(outcome.user));
    });
  }

  // ---------- GET /users/:userId (get) ----------
  r.get('/users/:userId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const userId = c.req.param('userId') as UserId;

    const user = await directory.getUser({ tenantId, userId });
    if (user === null) {
      c.status(statusFor('identity-user-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'identity-user-not-found',
            message: `No user with id "${userId as unknown as string}" under this tenant`,
            userId: userId as unknown as string,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeUser(user));
  });

  // ---------- GET /users/:userId/sessions (list active sessions) ----------
  r.get('/users/:userId/sessions', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const userId = c.req.param('userId') as UserId;

    const page = await directory.listSessions({ tenantId, userId });
    return c.json({
      data: page.data.map(serializeSession),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- POST /users/:userId/revoke-sessions (admin) ----------
  r.post('/users/:userId/revoke-sessions', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const userId = c.req.param('userId') as UserId;

    let outcome: Awaited<ReturnType<IdentityDirectoryBinding['revokeAllSessions']>>;
    try {
      outcome = await directory.revokeAllSessions({ tenantId, userId });
    } catch (err) {
      c.status(statusFor('identity-revoke-failed') as never);
      return c.json(
        toWireError(
          {
            code: 'identity-revoke-failed',
            message: err instanceof Error ? err.message : 'session revocation failed',
            userId: userId as unknown as string,
          },
          requestId,
        ),
      );
    }
    return c.json({
      userId: outcome.userId as unknown as string,
      revokedCount: outcome.revokedCount,
    });
  });

  return r;
}

function serializeUser(u: UserRecord): Record<string, unknown> {
  return {
    userId: u.userId as unknown as string,
    tenantId: u.tenantId as unknown as string,
    ...(u.primaryEmail !== undefined && { primaryEmail: u.primaryEmail }),
    ...(u.displayName !== undefined && { displayName: u.displayName }),
    createdAt: u.createdAt as unknown as string,
    ...(u.lastActiveAt !== undefined && { lastActiveAt: u.lastActiveAt as unknown as string }),
    ...(u.metadata !== undefined && { metadata: u.metadata }),
  };
}

function serializeSession(s: SessionSummary): Record<string, unknown> {
  return {
    sessionId: s.sessionId,
    userId: s.userId as unknown as string,
    providerId: s.providerId,
    createdAt: s.createdAt as unknown as string,
    expiresAt: s.expiresAt as unknown as string,
    scopes: s.scopes,
    ...(s.revokedAt !== undefined && { revokedAt: s.revokedAt as unknown as string }),
  };
}

/**
 * What an API key adds to whoami: whom it acts for, its id, and what it's
 * limited to, so a client can say "you're acme-ci, limited to project X".
 */
function keyFacts(c: Context<AppEnv>): Record<string, unknown> {
  const principal = callerPrincipal(c);
  const tokenId = c.get('tokenId') as string | undefined;
  const role = c.get('tokenRole');
  const projectId = c.get('tokenProjectId');
  return {
    ...(principal !== undefined && { principal: principalToWire(principal) }),
    ...(tokenId !== undefined && { tokenId }),
    ...(role !== undefined && { role }),
    ...(projectId !== undefined && { projectId }),
  };
}

const MAX_NAME_LENGTH = 200;

/** `{displayName, primaryEmail?}`, or why not. */
function parseCreateUser(raw: unknown): { displayName: string; primaryEmail?: string } | string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return 'Request body must be a JSON object';
  }
  const b = raw as { displayName?: unknown; primaryEmail?: unknown };
  if (
    typeof b.displayName !== 'string' ||
    b.displayName.trim() === '' ||
    b.displayName.length > MAX_NAME_LENGTH
  ) {
    return `\`displayName\` must be a non-empty string of at most ${MAX_NAME_LENGTH} characters`;
  }
  if (b.primaryEmail === undefined) return { displayName: b.displayName.trim() };
  if (typeof b.primaryEmail !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(b.primaryEmail)) {
    return '`primaryEmail` must be an email address';
  }
  return { displayName: b.displayName.trim(), primaryEmail: b.primaryEmail };
}
