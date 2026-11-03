// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Identity — canonical caller-identity surface.
 *
 * @wire /v1/identity/*  (packages/api/src/routes/identity.ts)
 * @generated Wire shapes from `../generated/api.js`.
 *
 * `whoami` is unconditionally mounted (returns tenantId + scopes for
 * bearer callers; enriches with user + session context when the
 * deployment wires an IdentityDirectoryBinding). The `/users/*` routes
 * mount only when the directory binding is present.
 */

import type {
  IdentitySessionCollectionPage,
  MyPermissions,
  RevokeSessionsResult,
  SecondFactorKey,
  SecondFactorProof,
  SecondFactorRecoveryCodes,
  SecondFactorRemoved,
  SecondFactorStatus,
  UserCollectionPage,
  UserRecord,
  WhoamiResult,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type IdentityUser = UserRecord;
export type IdentityUserPage = UserCollectionPage;
export type IdentitySessionPage = IdentitySessionCollectionPage;
export type WhoamiInfo = WhoamiResult;
export type { MyPermissions };
export type {
  SecondFactorKey,
  SecondFactorProof,
  SecondFactorRecoveryCodes,
  SecondFactorRemoved,
  SecondFactorStatus,
};
export type RevokeSessionsOutcome = RevokeSessionsResult;

export interface ListIdentityUsersFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly query?: string;
  /** Each person's `grants` too, in the same read. A runtime that doesn't read grants leaves them out. */
  readonly includeGrants?: boolean;
}

export interface IdentityClient {
  /** @wire GET /v1/identity/whoami — always mounted */
  whoami(): Promise<WhoamiInfo>;
  readonly me: IdentityMeClient;
  readonly users: IdentityUsersClient;
}

export interface IdentityMeClient {
  /**
   * What the caller may do, so a client hides what it can't: tenant admin,
   * its reviewer role and the roles it decides, its key's limits and
   * capabilities, the projects it may read with its role in each and how it
   * holds it, its orgs and teams, and what each project role allows. On a
   * runtime without an authorization store it throws a `KindgiApiError`
   * whose `error` is `{ code: 'server', serverCode:
   * 'permissions-unsupported' }` (a `not-found` one on a runtime from
   * before this route): read `whoami()`'s `tenantAdmin` and
   * `reviewerRole` instead.
   *
   * @wire GET /v1/identity/me/permissions
   */
  permissions(): Promise<MyPermissions>;
  /** Your own second factor: from a session only (`auth-not-session-token` with an API key). */
  readonly secondFactor: IdentityMeSecondFactorClient;
}

/**
 * Your second factor (an authenticator app, and its recovery codes). From
 * a session only. Mounted where the deployment keeps second factors. A
 * wrong code is an `auth` error whose `serverCode` is
 * `second-factor-invalid`; too many is `rate-limited`
 * (`second-factor-locked`), with `retryAfterSeconds`.
 */
export interface IdentityMeSecondFactorClient {
  /** @wire GET /v1/identity/me/second-factor */
  get(): Promise<SecondFactorStatus>;
  /**
   * A new key, shown this once; nothing changes until `confirm`. With one
   * set up already, `proof` from it is needed, and the new key replaces it.
   *
   * @wire POST /v1/identity/me/second-factor
   */
  start(proof?: SecondFactorProof): Promise<SecondFactorKey>;
  /**
   * A code from the new key: set up, and the 10 recovery codes, this once.
   *
   * @wire POST /v1/identity/me/second-factor/confirm
   */
  confirm(code: string): Promise<SecondFactorRecoveryCodes>;
  /**
   * 10 new recovery codes; the old ones stop working.
   *
   * @wire POST /v1/identity/me/second-factor/recovery-codes
   */
  newRecoveryCodes(proof: SecondFactorProof): Promise<SecondFactorRecoveryCodes>;
  /**
   * Off. Refused while the workspace requires one (`second-factor-required`).
   *
   * @wire POST /v1/identity/me/second-factor/remove
   */
  remove(proof: SecondFactorProof): Promise<SecondFactorRemoved>;
}

export interface IdentityUsersClient {
  /** @wire GET /v1/identity/users — requires directory binding; tenant admins only */
  list(filter?: ListIdentityUsersFilter): Promise<IdentityUserPage>;
  /** @wire GET /v1/identity/users/:userId — a tenant admin, or the person */
  get(userId: string): Promise<IdentityUser>;
  /** @wire GET /v1/identity/users/:userId/sessions — a tenant admin, or the person */
  listSessions(userId: string): Promise<IdentitySessionPage>;
  /** @wire POST /v1/identity/users/:userId/revoke-sessions — admin op */
  revokeSessions(
    userId: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<RevokeSessionsOutcome>;
}

export function makeIdentityClient(transport: Transport): IdentityClient {
  const seg = (s: string): string => encodeURIComponent(s);
  return {
    async whoami() {
      return transport.request<WhoamiInfo>({
        method: 'GET',
        path: '/v1/identity/whoami',
      });
    },
    me: {
      async permissions() {
        return transport.request<MyPermissions>({
          method: 'GET',
          path: '/v1/identity/me/permissions',
        });
      },
      secondFactor: {
        async get() {
          return transport.request<SecondFactorStatus>({
            method: 'GET',
            path: '/v1/identity/me/second-factor',
          });
        },
        async start(proof) {
          return transport.request<SecondFactorKey>({
            method: 'POST',
            path: '/v1/identity/me/second-factor',
            body: proof ?? {},
          });
        },
        async confirm(code) {
          return transport.request<SecondFactorRecoveryCodes>({
            method: 'POST',
            path: '/v1/identity/me/second-factor/confirm',
            body: { code },
          });
        },
        async newRecoveryCodes(proof) {
          return transport.request<SecondFactorRecoveryCodes>({
            method: 'POST',
            path: '/v1/identity/me/second-factor/recovery-codes',
            body: proof,
          });
        },
        async remove(proof) {
          return transport.request<SecondFactorRemoved>({
            method: 'POST',
            path: '/v1/identity/me/second-factor/remove',
            body: proof,
          });
        },
      },
    },
    users: {
      async list(filter) {
        return transport.request<IdentityUserPage>({
          method: 'GET',
          path: '/v1/identity/users',
          query: {
            ...(filter?.limit !== undefined && { limit: filter.limit }),
            ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
            ...(filter?.query !== undefined && { query: filter.query }),
            ...(filter?.includeGrants === true && { include: 'grants' }),
          },
        });
      },
      async get(userId) {
        return transport.request<IdentityUser>({
          method: 'GET',
          path: `/v1/identity/users/${seg(userId)}`,
        });
      },
      async listSessions(userId) {
        return transport.request<IdentitySessionPage>({
          method: 'GET',
          path: `/v1/identity/users/${seg(userId)}/sessions`,
        });
      },
      async revokeSessions(userId, options) {
        return transport.request<RevokeSessionsOutcome>({
          method: 'POST',
          path: `/v1/identity/users/${seg(userId)}/revoke-sessions`,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
    },
  };
}
