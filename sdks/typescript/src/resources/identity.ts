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
  RevokeSessionsResult,
  UserCollectionPage,
  UserRecord,
  WhoamiResult,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type IdentityUser = UserRecord;
export type IdentityUserPage = UserCollectionPage;
export type IdentitySessionPage = IdentitySessionCollectionPage;
export type WhoamiInfo = WhoamiResult;
export type RevokeSessionsOutcome = RevokeSessionsResult;

export interface ListIdentityUsersFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly query?: string;
}

export interface IdentityClient {
  /** @wire GET /v1/identity/whoami — always mounted */
  whoami(): Promise<WhoamiInfo>;
  readonly users: IdentityUsersClient;
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
    users: {
      async list(filter) {
        return transport.request<IdentityUserPage>({
          method: 'GET',
          path: '/v1/identity/users',
          query: {
            ...(filter?.limit !== undefined && { limit: filter.limit }),
            ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
            ...(filter?.query !== undefined && { query: filter.query }),
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
