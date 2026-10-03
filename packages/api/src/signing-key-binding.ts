// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, Result, SigningKeyId, TenantId } from '@kindgi/types';

/**
 * Caller-plugged surface for the API layer's **tenant-scoped signing-key
 * trust registry** — the seam behind the deploy route's signature
 * verification + trust-list cross-check.
 *
 * ## Position vs `SigningKeyBinding`
 *
 * the crypto module already exposes a `SigningKeyBinding` — a low-level
 * KMS seam that returns raw key bytes for a `SigningKeyId`. That binding
 * is deployment-wide; every request finds the same keys.
 *
 * THIS binding is a **higher-level, tenant-scoped trust registry**. It
 * answers "for tenant T, is this public key allowed to sign deploys /
 * artifacts?" and performs signature verification against the registered
 * trust list. A production adapter typically wraps the crypto-layer
 * binding for the underlying primitive ops and layers tenant-scoping,
 * revocation, and audit on top.
 *
 * Consumers alias one of the two when importing both — TypeScript resolves
 * them by module path but the local name collides.
 *
 * ## Two responsibilities
 *
 * 1. **Trust registry** (`listTrusted` / `getTrusted` / `addTrusted` /
 *    `revokeTrusted`) — per-tenant CRUD over the set of public keys
 *    permitted to sign deploys and admin operations.
 * 2. **Verification** (`isTrusted` / `verify`) — cheap boolean trust
 *    check + a full signature-verification call. The `POST /v1/deployments`
 *    route calls `isTrusted` (which must be `true`) and then verifies the
 *    Ed25519 signature itself; it does not call `verify`.
 *
 * Tenant-scoped: callers pass `tenantId` explicitly. Same trust list
 * partitioning as every other admin surface.
 *
 * ## Seam only
 *
 * No implementation is bundled here; the `POST /v1/deployments` route
 * runs its trust check through this interface.
 */
export interface SigningKeyBinding {
  // -------------- verification --------------

  /**
   * Cheap trust check for the signature step of `POST /v1/deployments`.
   * Returns `true` when the given `(keyId, publicKey)` pair appears on
   * the tenant's trust list AND has not been revoked. `false` otherwise —
   * the route surfaces `false` as `403 signer-not-trusted`.
   *
   * The pair is checked jointly to defend against a key-id collision
   * across tenants: two tenants MAY use the same `SigningKeyId` for
   * their own keys as long as the public bytes differ. Trust is bound
   * to the exact bytes.
   */
  isTrusted(input: IsTrustedInput): Promise<Result<boolean, SigningKeyError>>;
  /**
   * Verify a raw Ed25519 signature over a canonicalised payload against
   * the trusted key — e.g. the canonical deploy envelope
   * (`(imageDigest, artifactVersion, indexHash, tenantId, publishedAt)`)
   * as `payload`. The binding computes the verification and returns
   * `valid: true` on cryptographic match.
   *
   * Bindings MUST NOT trust the caller's assertion that the key is
   * trusted — they re-run the trust check as part of `verify`, so
   * `signer-not-trusted` shortcuts before `signature-invalid`.
   */
  verify(input: VerifyInput): Promise<Result<VerifyOutcome, SigningKeyError>>;

  // -------------- trust registry --------------

  /**
   * Cursor-paginated list of trusted keys for the tenant. Sort order is
   * binding-defined (e.g. `createdAt desc, keyId desc`).
   */
  listTrusted(input: ListTrustedInput): Promise<TrustedKeyPage>;
  /**
   * Look up a single trusted key by id. `null` when unknown to the
   * tenant OR revoked; revoked entries are excluded here (they still
   * appear via `listTrusted` with `includeRevoked: true`).
   */
  getTrusted(input: GetTrustedInput): Promise<TrustedKey | null>;
  /**
   * Add a key to the tenant's trust list. Idempotent per `(keyId,
   * publicKey)` — re-adding the same pair returns
   * `{ kind: 'already-trusted' }` with the existing entry (no bump to
   * `createdAt`). Different `publicKey` under the same `keyId` is
   * rejected with `key-id-conflict` — callers rotate by allocating a
   * new keyId, not by rebinding one.
   */
  addTrusted(input: AddTrustedInput): Promise<AddTrustedOutcome>;
  /**
   * Revoke a trusted key. Idempotent — revoking an already-revoked or
   * unknown key returns `{ revoked: false }`; first-time revocation
   * returns `{ revoked: true }`. The entry is retained (soft-delete)
   * so historical `Deployment.signerKeyId` refs remain resolvable for
   * audit; `isTrusted` returns `false` for revoked entries.
   */
  revokeTrusted(input: RevokeTrustedInput): Promise<RevokeTrustedOutcome>;
}

// -------------------- record --------------------

/**
 * Wire shape for a trusted-key registration. `publicKey` is base64 of
 * the raw key bytes (Ed25519 = 32 bytes); `algorithm` is the closed set
 * from the crypto module — extended here as an open string so future
 * algorithms don't require a package bump on this file.
 */
export interface TrustedKey {
  readonly keyId: SigningKeyId;
  readonly tenantId: TenantId;
  /** `'ed25519'` today. Open string for future algorithms. */
  readonly algorithm: string;
  /** Base64 of the raw public key bytes. */
  readonly publicKey: string;
  /** Optional human-readable label — e.g. `'acme-staging-2026-01'`. */
  readonly label?: string;
  /** ISO-8601 timestamp of first registration. */
  readonly createdAt: string;
  /** ISO-8601 timestamp of revocation; absent when active. */
  readonly revokedAt?: string;
  /** Reason string supplied at revocation time. */
  readonly revokedReason?: string;
}

// -------------------- verify --------------------

export interface IsTrustedInput {
  readonly tenantId: TenantId;
  readonly keyId: SigningKeyId;
  /** Base64 of the raw public-key bytes the signer presented. */
  readonly publicKey: string;
}

export interface VerifyInput {
  readonly tenantId: TenantId;
  readonly keyId: SigningKeyId;
  /** Base64 of the raw public-key bytes. */
  readonly publicKey: string;
  /** Raw bytes over which the signature was computed. */
  readonly payload: Uint8Array;
  /** Base64 of the signature bytes. */
  readonly signature: string;
}

export interface VerifyOutcome {
  readonly valid: boolean;
  /**
   * When `valid: false`, a hint at why — `signature-mismatch` /
   * `signer-not-trusted` / `algorithm-unsupported`. Useful for logs.
   */
  readonly reason?: string;
}

// -------------------- registry --------------------

export interface ListTrustedInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
  /** When `true`, revoked entries are included. Default `false`. */
  readonly includeRevoked?: boolean;
  /** Prefix match on `TrustedKey.label` — useful for env-scoped listings. */
  readonly labelFilter?: string;
}

export interface TrustedKeyPage {
  readonly data: readonly TrustedKey[];
  readonly nextCursor?: Cursor;
}

export interface GetTrustedInput {
  readonly tenantId: TenantId;
  readonly keyId: SigningKeyId;
}

export interface AddTrustedInput {
  readonly tenantId: TenantId;
  readonly keyId: SigningKeyId;
  readonly algorithm: string;
  readonly publicKey: string;
  readonly label?: string;
}

export type AddTrustedOutcome =
  | { readonly kind: 'ok'; readonly key: TrustedKey }
  | { readonly kind: 'already-trusted'; readonly key: TrustedKey }
  | {
      /**
       * Same `keyId` already registered but with different `publicKey`
       * bytes. Callers rotate by allocating a fresh `keyId`.
       */
      readonly kind: 'key-id-conflict';
      readonly existing: TrustedKey;
    }
  | {
      /**
       * The key couldn't be trusted. `signing-key-revoked`: the id was
       * revoked, and revocation is final (rotate under a new id). Other
       * codes are store failures.
       */
      readonly kind: 'error';
      readonly code: string;
      readonly message: string;
    };

export interface RevokeTrustedInput {
  readonly tenantId: TenantId;
  readonly keyId: SigningKeyId;
  /** Optional audit reason surfaced through `TrustedKey.revokedReason`. */
  readonly reason?: string;
}

export interface RevokeTrustedOutcome {
  readonly revoked: boolean;
}

// -------------------- error --------------------

export type SigningKeyError =
  | { readonly code: 'signing-key-not-found'; readonly message: string; readonly keyId: string }
  | {
      readonly code: 'signing-key-algorithm-unsupported';
      readonly message: string;
      readonly algorithm: string;
    }
  | {
      readonly code: 'signing-key-store-error';
      readonly message: string;
      readonly cause?: unknown;
    };
