// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ApiTokenId, ProjectId, TenantId } from '@kindgi/types';

/**
 * Admin surface for API keys: mint, list, read, revoke. Distinct from
 * `TokenResolver`, which is the read path used by the auth middleware.
 * Splitting keeps the auth hot path free of write concerns and lets
 * deployments plug in different implementations.
 *
 * An API key is a machine credential: a service account
 * (`service_account:<tokenId>`) with a role in its tenant and an explicit
 * list of framework capabilities. `POST /v1/tokens` mints;
 * `GET /v1/tokens` and `GET /v1/tokens/:tokenId` read (never the secret);
 * `POST /v1/tokens/:tokenId/revoke` revokes.
 */
export interface TokenAdmin {
  mint(input: TokenMintInput): Promise<TokenMintOutput>;
  list(input: TokenListInput): Promise<readonly ApiTokenRecord[]>;
  get(input: TokenGetInput): Promise<ApiTokenRecord | undefined>;
  revoke(input: TokenRevokeInput): Promise<TokenRevokeOutcome>;
}

/**
 * A key's role in its tenant. `admin` administers the tenant (and mints,
 * lists and revokes keys); `member` belongs to it and administers nothing.
 */
export type ApiTokenRole = 'admin' | 'member';

export const API_TOKEN_ROLES: readonly ApiTokenRole[] = ['admin', 'member'];

export interface TokenMintInput {
  readonly tenantId: TenantId;
  readonly role: ApiTokenRole;
  /**
   * Framework capabilities the key carries (`env:write`, `secrets:write`,
   * …). The route only lets a caller grant capabilities it holds itself.
   */
  readonly capabilities: readonly string[];
  /** Optional human-readable label. Shown in admin UIs. */
  readonly label?: string;
  /** Optional expiration date. */
  readonly expiresAt?: Date;
  /** Optional project scope; when set, tokens are only valid for that project. */
  readonly projectId?: ProjectId;
  /**
   * Who minted it, as a principal reference: `user:<id>` or
   * `service_account:<tokenId>`.
   */
  readonly createdBy?: string;
}

export interface TokenMintOutput {
  /** The new key, as `list` and `get` will show it. */
  readonly record: ApiTokenRecord;
  /**
   * The plaintext bearer token. Returned to the caller ONCE, at mint
   * time. Stores must persist a hash — not the plaintext — so lost
   * tokens can only be replaced, not recovered.
   */
  readonly token: string;
}

/** What a key looks like after minting: everything but its secret. */
export interface ApiTokenRecord {
  readonly tokenId: ApiTokenId;
  readonly role: ApiTokenRole;
  readonly capabilities: readonly string[];
  readonly label?: string;
  readonly projectId?: ProjectId;
  readonly createdBy?: string;
  readonly createdAt: Date;
  readonly expiresAt?: Date;
  /** Set once revoked. A revoked key never resolves again. */
  readonly revokedAt?: Date;
  /** When the key last authenticated a request (updated at most once a minute). */
  readonly lastUsedAt?: Date;
}

/**
 * A page of keys, newest first (`createdAt` then `tokenId`, descending).
 * The store returns up to `limit` records strictly after `after` in that
 * order; the route asks for one more than it shows, to know whether more
 * remain.
 */
export interface TokenListInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  /** The last record of the previous page. */
  readonly after?: { readonly createdAt: Date; readonly tokenId: ApiTokenId };
}

export interface TokenGetInput {
  readonly tenantId: TenantId;
  readonly tokenId: ApiTokenId;
}

export interface TokenRevokeInput {
  readonly tenantId: TenantId;
  readonly tokenId: ApiTokenId;
}

export type TokenRevokeOutcome = { readonly kind: 'ok' } | { readonly kind: 'not-found' };
