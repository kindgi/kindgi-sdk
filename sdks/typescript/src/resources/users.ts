// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Filter, SessionId, UserId } from '@kindgi/types';

import { KindgiApiError, notYetWired } from '../errors.js';
import { type ListPage, type WirePage, listPage } from '../list-page.js';
import type { Transport } from '../transport.js';
import type {
  PersonGrant,
  PersonGrants,
  RevokeSessionsResult,
  Session,
  UnregisterUserResult,
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
 *   - `GET  /v1/identity/users/{userId}/grants` (a person's grants:
 *     tenant admins, or the person) and `POST …/grant|ungrant` (tenant
 *     admin; tenant admins only)
 *   - `POST /v1/identity/users/{userId}/unregister` (remove a person:
 *     their keys, sessions and grants go at once; tenant admins only)
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
   * What a person may do, as granted directly: tenant admin, project and
   * team roles, the reviewer roster. A tenant admin reads anyone's;
   * anyone else only their own. `501 person-grants-unsupported` on a
   * runtime without an authorization store.
   *
   * @wire `GET /v1/identity/users/{userId}/grants` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1identity~1users~1{userId}~1grants/get`.
   */
  grants(id: UserId): Promise<PersonGrants>;

  /**
   * Make a person a tenant admin, before the call answers. Tenant admins
   * only. Project and team roles have their own membership routes.
   *
   * @wire `POST /v1/identity/users/{userId}/grant` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1identity~1users~1{userId}~1grant/post`.
   */
  grant(
    id: UserId,
    grant: PersonGrant,
    options?: { readonly idempotencyKey?: string },
  ): Promise<PersonGrants>;

  /**
   * Remove tenant admin from a person. Refused for the only person who
   * holds it (`409 last-tenant-admin`) and for the seed user
   * (`409 seed-user-admin`). Tenant admins only.
   *
   * @wire `POST /v1/identity/users/{userId}/ungrant` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1identity~1users~1{userId}~1ungrant/post`.
   */
  ungrant(
    id: UserId,
    grant: PersonGrant,
    options?: { readonly idempotencyKey?: string },
  ): Promise<PersonGrants>;

  /**
   * Remove a person from the tenant, where the directory can: every API
   * key and session of theirs is revoked and every grant and membership
   * taken away before it returns (their keys get 401 at once). Their
   * record stays, with `unregisteredAt`; their email is free again.
   * Removing someone already removed changes nothing. Refused for
   * yourself, the deployment's seed user (`identity-user-unregister-refused`)
   * and the only tenant admin (`last-tenant-admin`). Tenant admins only.
   */
  unregister(
    id: UserId,
    options?: { readonly idempotencyKey?: string },
  ): Promise<UnregisterUserResult>;

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
  /** People who were removed (`unregisteredAt`) too. Default: only the people still here. */
  readonly includeUnregistered?: boolean;
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
          ...(filter?.includeUnregistered === true && { includeUnregistered: 'true' }),
        },
      });
      return listPage(page);
    },

    async grants(id) {
      return transport.request<PersonGrants>({
        method: 'GET',
        path: `/v1/identity/users/${encodeURIComponent(id as unknown as string)}/grants`,
      });
    },

    async grant(id, grant, options) {
      return transport.request<PersonGrants>({
        method: 'POST',
        path: `/v1/identity/users/${encodeURIComponent(id as unknown as string)}/grant`,
        body: grant,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },

    async ungrant(id, grant, options) {
      return transport.request<PersonGrants>({
        method: 'POST',
        path: `/v1/identity/users/${encodeURIComponent(id as unknown as string)}/ungrant`,
        body: grant,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },

    async unregister(id, options) {
      return transport.request<UnregisterUserResult>({
        method: 'POST',
        path: `/v1/identity/users/${encodeURIComponent(id as unknown as string)}/unregister`,
        body: {},
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
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
