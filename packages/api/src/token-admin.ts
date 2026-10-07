// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ApiTokenId, ProjectId, TenantId } from '@kindgi/types';

/**
 * Admin surface for API keys: mint, list, read, revoke. Distinct from
 * `TokenResolver`, which is the read path used by the auth middleware.
 * Splitting keeps the auth hot path free of write concerns and lets
 * deployments plug in different implementations.
 *
 * An API key always acts for one principal (`TokenPrincipal`): a person
 * (`user:<id>`) or a service account (`service_account:<id>`), with that
 * principal's grants and nothing more. Its `role` is a ceiling under those
 * grants, and its `projectId` narrows it to one project; neither ever
 * widens it. `POST /v1/tokens` mints; `GET /v1/tokens` and
 * `GET /v1/tokens/:tokenId` read (never the secret);
 * `POST /v1/tokens/:tokenId/revoke` revokes.
 */
export interface TokenAdmin {
  /** The new key and its secret, or why the store refused it. */
  mint(input: TokenMintInput): Promise<TokenMintOutput | TokenMintRefusal>;
  list(input: TokenListInput): Promise<readonly ApiTokenRecord[]>;
  get(input: TokenGetInput): Promise<ApiTokenRecord | undefined>;
  revoke(input: TokenRevokeInput): Promise<TokenRevokeOutcome>;
}

/**
 * A key's role: the most it may do, under its principal's grants. An
 * `admin` key may administer the tenant when its principal can; a `member`
 * key administers nothing, even when its principal is an admin (a
 * day-to-day key that can't change keys, grants or policies).
 */
export type ApiTokenRole = 'admin' | 'member';

export const API_TOKEN_ROLES: readonly ApiTokenRole[] = ['admin', 'member'];

/** Whom a key acts for: a person, or a service account. */
export type TokenPrincipal =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'service-account'; readonly serviceAccountId: string };

export interface TokenMintInput {
  readonly tenantId: TenantId;
  /**
   * Whom the key acts for: the caller, unless a tenant admin names
   * someone else. Absent when a tenant admin whose token names no
   * principal mints for themselves; the key is then a service account of
   * its own, as every key was before principals.
   */
  readonly principal?: TokenPrincipal;
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
  /** Optional project: the key is narrowed to it, refused on any other. */
  readonly projectId?: ProjectId;
  /**
   * Who minted it, as a principal reference: `user:<id>` or
   * `service_account:<tokenId>`.
   */
  readonly createdBy?: string;
}

/**
 * A mint the store refused: the principal doesn't exist (or is
 * unregistered), or an `admin` key for a principal that isn't a tenant
 * admin.
 */
export type TokenMintRefusal =
  | { readonly kind: 'principal-not-found'; readonly message: string }
  | { readonly kind: 'role-exceeds-principal'; readonly message: string };

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
  /** Whom it acts for. Absent from stores built before principals. */
  readonly principal?: TokenPrincipal;
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
  /** Only the keys that act for this principal (a person sees only their own). */
  readonly principal?: TokenPrincipal;
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
