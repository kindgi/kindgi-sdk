// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { TenantId } from '@kindgi/types';

/**
 * Caller-plugged catalog of OAuth 2.0 / OIDC identity providers the
 * deployment offers to its tenants. Same pattern as
 * `ProviderRegistryBinding` (model providers) — the API package does
 * NOT own provider persistence, and secrets never cross the wire.
 *
 * A `ProviderConfig` carries ONLY a `clientSecretRef` — an opaque
 * pointer that the deployment resolves server-side (env-var lookup,
 * secrets-manager path, KMS handle, etc.). The plaintext client secret
 * is exchanged with the identity provider inside the deployment's
 * boundary during the code→token exchange in `/v1/auth/callback` and
 * never surfaces on any HTTP response.
 *
 * PKCE is mandatory (S256). Providers that don't support PKCE are
 * rejected at boot; the framework does NOT emit `code_challenge_method`
 * negotiation.
 */
export interface IdentityProviderBinding {
  list(input: IdentityProviderListInput): Promise<IdentityProviderPage>;
  get(input: IdentityProviderGetInput): Promise<ProviderConfig | null>;
  register(input: IdentityProviderRegisterInput): Promise<IdentityProviderRegisterOutcome>;
  unregister(input: IdentityProviderUnregisterInput): Promise<IdentityProviderUnregisterOutcome>;
}

export type IdentityProviderKind = 'oauth2' | 'oidc';

export interface ProviderConfig {
  /** Stable string chosen by the deployment (e.g. `acme-sso`, `globex-oidc`). */
  readonly providerId: string;
  readonly kind: IdentityProviderKind;
  readonly clientId: string;
  /**
   * Opaque pointer resolved server-side. Never a plaintext secret. The
   * shape (env-var name / secrets-manager path / KMS handle) is a
   * deployment convention, not a framework one.
   */
  readonly clientSecretRef: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly userinfoEndpoint?: string;
  readonly scopes: readonly string[];
  /**
   * OAuth 2.1 BCP redirect-URI allowlist. When present and non-empty,
   * `POST /v1/auth/login/:providerId` rejects any `redirectUri` (whether
   * supplied in the body or resolved from `metadata.defaultRedirectUri`)
   * that is not an exact match to a list entry — 400
   * `redirect-uri-not-allowed`. `POST /v1/auth/callback/:providerId`
   * cross-checks the state row's stored `redirect_uri` against the same
   * list — 400 `redirect-uri-mismatch` if the allowlist was tightened
   * between login and callback. Absent or empty → any redirect_uri is
   * accepted (pass-through; deployments MUST populate
   * this to reach OAuth 2.1 BCP compliance).
   *
   * Exact-string match, not prefix or regex — the OAuth 2.1 BCP
   * mandates literal comparison to prevent redirect-URI injection.
   */
  readonly allowedRedirectUris?: readonly string[];
  /**
   * Optional per-provider claim mapping. When present, the `ExchangeCodeFn`
   * / `RefreshTokenFn` implementations translate provider claims into the
   * Kindgi `Session` shape according to this spec. Absent → pass-
   * through (provider `sub` → `userId`, `email` → `email`, `name` →
   * `displayName`, scopes come from the token response). A deployment's
   * own `ExchangeCodeFn` MAY honor this field the same way.
   */
  readonly claimMapping?: ClaimMappingSpec;
  readonly metadata?: Record<string, unknown>;
}

/**
 * How provider claims map into Kindgi's session shape. All fields
 * are optional — the closer a provider's claim naming is to the OIDC
 * defaults (`sub` / `email` / `name`), the fewer overrides the
 * deployment needs. Field values are dot-path claim references
 * relative to the provider's userinfo / id_token payload:
 *
 * - `"sub"` reads top-level `sub`.
 * - `"profile.email"` reads `payload.profile.email` (dot-navigated).
 * - `"https://acme.com/roles"` reads the raw claim under that URI-
 *   shaped key (namespaced custom claims — no dot navigation).
 *
 * The scopes case is a discriminated shape because scope claims in
 * the wild come as either space-separated strings, comma-separated,
 * or a JSON array — the `delimiter` field lets deployments say how to
 * split. When omitted (or the resolved claim is already an array),
 * splitting is skipped.
 */
export interface ClaimMappingSpec {
  /** Provider claim path for the Kindgi `userId`. Default: `sub`. */
  readonly userId?: string;
  /** Provider claim path for the caller's email. Default: `email`. */
  readonly email?: string;
  /** Provider claim path for the caller's display name. Default: `name`. */
  readonly displayName?: string;
  /**
   * Provider claim path + optional delimiter for the Kindgi OAuth
   * scopes list. When absent, scopes come from the OAuth token
   * response `scope` field, not from claims.
   */
  readonly scopes?: ClaimMappingScopesSpec;
  /**
   * Extra claim paths to preserve verbatim on `Session.metadata`.
   * Values are copied as-is. Absent → all claims flow through in
   * `metadata`.
   */
  readonly metadata?: readonly string[];
}

export interface ClaimMappingScopesSpec {
  /** Claim path for the raw scopes value. */
  readonly claim: string;
  /**
   * When the resolved claim is a string, split on this delimiter to
   * produce the scopes array. When absent, split on any whitespace.
   * Ignored when the resolved claim is already an array.
   */
  readonly delimiter?: string;
}

export interface IdentityProviderListInput {
  readonly tenantId: TenantId;
}

export interface IdentityProviderPage {
  readonly data: readonly ProviderConfig[];
}

export interface IdentityProviderGetInput {
  readonly tenantId: TenantId;
  readonly providerId: string;
}

export interface IdentityProviderRegisterInput {
  readonly tenantId: TenantId;
  readonly config: ProviderConfig;
}

export type IdentityProviderRegisterOutcome = {
  readonly kind: 'ok';
  readonly providerId: string;
};

export interface IdentityProviderUnregisterInput {
  readonly tenantId: TenantId;
  readonly providerId: string;
}

export interface IdentityProviderUnregisterOutcome {
  readonly unregistered: boolean;
}

/**
 * Result of the OAuth code→session exchange the callback route delegates
 * to the identity provider. Distinct from `SessionCreateInput` because
 * the framework decides the `SessionId` (opaque), while the provider
 * decides `userId` / `accessToken` / `scopes`.
 */
export interface ExchangeCodeInput {
  readonly tenantId: TenantId;
  readonly providerId: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

export interface ExchangeCodeOutcome {
  readonly userId: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt: Date;
  readonly scopes: readonly string[];
  readonly claims?: Record<string, unknown>;
}

/**
 * Optional companion binding used by `POST /v1/auth/callback` and
 * `POST /v1/auth/refresh`. Deployments that only implement provider
 * registry CRUD (and want to run the exchange themselves) can inline
 * this closure via `CreateAppInput.exchangeCode`. A typical
 * implementation calls the provider `tokenEndpoint` with PKCE +
 * client-secret client authentication.
 */
export type ExchangeCodeFn = (input: ExchangeCodeInput) => Promise<ExchangeCodeOutcome>;

/**
 * Optional refresh-token exchange. When present, `POST /v1/auth/refresh`
 * rotates the underlying provider tokens before minting a new session
 * token. When absent, the refresh route simply revokes the old session
 * and re-issues a session token with the same expiry (still useful for
 * key rotation on the framework side even when the provider stays put).
 */
export interface RefreshTokenInput {
  readonly tenantId: TenantId;
  readonly providerId: string;
  readonly refreshToken: string;
}

export type RefreshTokenFn = (input: RefreshTokenInput) => Promise<ExchangeCodeOutcome>;
