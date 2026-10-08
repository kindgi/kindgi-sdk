// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Filter, SessionId, UserId } from '@kindgi/types';

import { KindgiApiError, notYetWired } from '../errors.js';
import { type ListPage, type WirePage, listPage } from '../list-page.js';
import type { Transport } from '../transport.js';
import type {
  RevokeSessionsResult,
  Session,
  User,
  UserPatch,
  UserSpec,
  WhoamiResult,
} from '../types.js';

/**
 * Users resource — identity read + session administration.
 *
 * Routes:
 *   - `GET  /v1/identity/users` (cursor-paginated list, `?query=`
 *     displayName prefix)
 *   - `GET  /v1/identity/users/{userId}` (get; `404 identity-user-not-found`
 *     on unknown or cross-tenant)
 *   - `GET  /v1/identity/whoami` (self — returns `WhoamiResult`, not
 *     `User`; carries the current-token's auth context plus the
 *     fuller `UserRecord` when the token has a `userId`)
 *   - `GET  /v1/identity/users/{userId}/sessions` (active sessions for
 *     a user; `IdentitySessionSummary` — provider access-token +
 *     refresh-token NEVER cross the wire)
 *   - `POST /v1/identity/users/{userId}/revoke-sessions` (admin;
 *     revokes ALL sessions for a user, returns `revokedCount`)
 *
 * User records live in the deployment's identity directory (LDAP,
 * SCIM or a bespoke store, plugged in through
 * `IdentityDirectoryBinding`). A tenant admin can add a person
 * (`users.create`, `POST /v1/identity/users`) where the directory can; the
 * API has no routes to update or deactivate users — `users.update` /
 * `.deactivate` throw `not-yet-wired`.
 *
 * `users.me()` returns `WhoamiResult`, which carries more than a
 * `User`. Sessions are revoked all at once per user
 * (`sessions.revokeAll`); there is no per-session revoke route.
 */
export interface UsersClient {
  /**
   * Add a person to the tenant, with no grants: give them a role, then
   * mint their first key with `tokens.create({ for: { kind: 'user', id } })`.
   * Tenant admins only; mounted where the identity directory can add
   * people. Another person's email is `409 identity-user-email-taken`.
   *
   * @wire `POST /v1/identity/users` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1identity~1users/post`.
   */
  create(spec: UserSpec, options?: { readonly idempotencyKey?: string }): Promise<UserId>;

  /**
   * @wire `GET /v1/identity/users/{userId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1identity~1users~1{userId}/get`.
   */
  get(id: UserId): Promise<User>;

  /**
   * Introspect the current caller's auth context. Bearer-token callers
   * see `tenantId` only (plus optional `userId` when the token was
   * minted with one); session-token callers additionally see
   * `sessionId`, `providerId`, `scopes`, and `expiresAt`. When the
   * token carries a `userId`, the identity directory attaches the
   * fuller `UserRecord`.
   *
   * @wire `GET /v1/identity/whoami` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1identity~1whoami/get`.
   *
   * Returns `WhoamiResult` (tenant + scopes + optional session / user
   * context), not a `User`.
   */
  me(): Promise<WhoamiResult>;

  /**
   * @wire `GET /v1/identity/users` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1identity~1users/get`.
   */
  list(filter?: UserFilter): Promise<ListPage<User>>;

  /**
   * @unwired No user-update route — users live in the deployment's
   *   identity directory.
   */
  update(id: UserId, patch: UserPatch): Promise<void>;

  /**
   * @unwired No user-deactivate route — users live in the
   *   deployment's identity directory.
   */
  deactivate(id: UserId): Promise<void>;

  readonly sessions: SessionsClient;
}

export interface SessionsClient {
  /**
   * Active sessions for a user. Provider access-token / refresh-token
   * NEVER cross the wire, even to admins.
   *
   * @wire `GET /v1/identity/users/{userId}/sessions` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1identity~1users~1{userId}~1sessions/get`.
   */
  list(userId: UserId): Promise<ListPage<Session>>;

  /**
   * Revoke ALL sessions for a user. Admin-scope. Idempotent on
   * already-revoked sets (returns `revokedCount: 0`).
   *
   * @wire `POST /v1/identity/users/{userId}/revoke-sessions` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1identity~1users~1{userId}~1revoke-sessions/post`.
   */
  revokeAll(
    userId: UserId,
    options?: { readonly idempotencyKey?: string },
  ): Promise<RevokeSessionsResult>;

  /**
   * @unwired No per-session revoke route; `revokeAll(userId)` revokes
   *   every session of a user.
   */
  revoke(id: SessionId): Promise<void>;
}

export interface UserFilter extends Filter {
  /** Server-side displayName prefix match. Case-sensitive. */
  readonly query?: string;
}

export function makeUsersClient(transport: Transport): UsersClient {
  return {
    async create(spec, options) {
      if (spec.orgId !== undefined || spec.metadata !== undefined) {
        throw new KindgiApiError(
          notYetWired('users.create', '`orgId` and `metadata` are not on the wire'),
        );
      }
      const created = await transport.request<User>({
        method: 'POST',
        path: '/v1/identity/users',
        body: {
          displayName: spec.displayName,
          ...(spec.email !== undefined && { primaryEmail: spec.email }),
        },
        ...(options?.idempotencyKey !== undefined && {
          idempotencyKey: options.idempotencyKey,
        }),
      });
      return created.userId;
    },

    async get(id) {
      return transport.request<User>({
        method: 'GET',
        path: `/v1/identity/users/${encodeURIComponent(id as unknown as string)}`,
      });
    },

    async me() {
      return transport.request<WhoamiResult>({
        method: 'GET',
        path: '/v1/identity/whoami',
      });
    },

    async list(filter) {
      const page = await transport.request<WirePage<User>>({
        method: 'GET',
        path: '/v1/identity/users',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
          ...(filter?.query !== undefined && { query: filter.query }),
        },
      });
      return listPage(page);
    },

    async update(_id, _patch) {
      throw new KindgiApiError(
        notYetWired(
          'users.update',
          'no user-update route on the wire — framework does NOT own user persistence',
        ),
      );
    },

    async deactivate(_id) {
      throw new KindgiApiError(
        notYetWired(
          'users.deactivate',
          'no user-deactivate route on the wire — framework does NOT own user persistence',
        ),
      );
    },

    sessions: {
      async list(userId) {
        const page = await transport.request<WirePage<Session>>({
          method: 'GET',
          path: `/v1/identity/users/${encodeURIComponent(userId as unknown as string)}/sessions`,
        });
        return listPage(page);
      },

      async revokeAll(userId, options) {
        return transport.request<RevokeSessionsResult>({
          method: 'POST',
          path: `/v1/identity/users/${encodeURIComponent(userId as unknown as string)}/revoke-sessions`,
          body: {},
          ...(options?.idempotencyKey !== undefined && {
            idempotencyKey: options.idempotencyKey,
          }),
        });
      },

      async revoke(_id) {
        throw new KindgiApiError(
          notYetWired(
            'users.sessions.revoke',
            'no per-session revoke route on the wire — wire revokes ALL sessions for a user via revokeAll(userId); per-session revoke has design merit but no route yet',
          ),
        );
      },
    },
  };
}
