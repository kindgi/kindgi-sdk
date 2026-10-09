// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { TenantId } from '@kindgi/types';

/**
 * Caller-plugged catalog of the identity providers a tenant signs in
 * with: OIDC and SAML identity providers (sign-in), and plain OAuth 2.0
 * providers. Same pattern as `ProviderRegistryBinding` (model providers):
 * the API package does NOT own provider persistence, and secrets never
 * cross the wire.
 *
 * A provider carries only REFERENCES to its secrets (`clientSecretRef`,
 * `spSigningKeyRef`, `spDecryptionKeyRef`): opaque pointers the deployment
 * resolves server-side (env-var lookup, secrets-manager path, KMS handle,
 * etc.). The secrets themselves are used inside the deployment's boundary
 * and never surface on any HTTP response.
 *
 * PKCE is mandatory (S256) for the OAuth flows.
 */
export interface IdentityProviderBinding {
  list(input: IdentityProviderListInput): Promise<IdentityProviderPage>;
  get(input: IdentityProviderGetInput): Promise<ProviderConfig | null>;
  register(input: IdentityProviderRegisterInput): Promise<IdentityProviderRegisterOutcome>;
  unregister(input: IdentityProviderUnregisterInput): Promise<IdentityProviderUnregisterOutcome>;
  /**
   * The ways a person can sign in, before anyone is signed in
   * (`GET /v1/auth/sign-in-options`, unauthenticated). Answer by the email
   * DOMAIN only, never by whether a person exists:
   * - with `emailDomain`: the providers whose `domains` include it, from
   *   the one tenant the domain is verified for (the deployment decides
   *   how: e.g. the only tenant it serves, or one its operator named);
   *   none when the domain isn't verified for any tenant;
   * - without: the route doesn't ask. Sign-in is email first, so nothing
   *   is offered before an email.
   * Absent → the route answers an empty list.
   */
  readonly signInOptions?: (input: SignInOptionsInput) => Promise<readonly SignInOption[]>;
  /**
   * What to give the identity provider so it can send people back
   * (`signIn`), for a provider registered now or later under this
   * `providerId`: the same before registration, after it, and after an
   * unregister and a new registration, so an admin can set up the
   * identity provider's side first. `undefined` when this deployment
   * doesn't sign in with that `kind`.
   * Absent → `GET /v1/auth/providers/:providerId/sign-in` isn't mounted.
   */
  readonly signInUrls?: (
    input: IdentityProviderSignInUrlsInput,
  ) => Promise<ProviderSignIn | undefined>;
  /**
   * Replace a registered provider's configuration, keeping its `signIn`
   * (the identity provider's side doesn't change). Validated as a new
   * registration is.
   * Absent → `PATCH /v1/auth/providers/:providerId` isn't mounted.
   */
  readonly update?: (input: IdentityProviderUpdateInput) => Promise<IdentityProviderUpdateOutcome>;
}

export interface IdentityProviderSignInUrlsInput {
  readonly tenantId: TenantId;
  readonly providerId: string;
  readonly kind: IdentityProviderKind;
}

export interface IdentityProviderUpdateInput {
  readonly tenantId: TenantId;
  /** The whole new configuration (the route merges the changes in). */
  readonly config: ProviderConfig;
}

export type IdentityProviderUpdateOutcome =
  | { readonly kind: 'ok'; readonly provider: ProviderConfig }
  | {
      /** As on registration: 422 `identity-provider-invalid`, with `message`. */
      readonly kind: 'invalid';
      readonly message: string;
    }
  | { readonly kind: 'not-found' };

export interface SignInOptionsInput {
  /** Lowercase, from the email the person typed. */
  readonly emailDomain?: string;
}

/** One way to sign in, as a sign-in page shows it. */
export interface SignInOption {
  readonly providerId: string;
  /** "Sign in with …". */
  readonly displayName: string;
  /** Where the browser goes to start signing in with this provider. */
  readonly signInUrl: string;
  /**
   * Whose it is: a workspace's own identity provider (`tenant`), or one
   * the deployment offers everyone it has added ("Continue with Google",
   * `deployment`). A sign-in page shows a workspace's own first. Absent:
   * `tenant`.
   */
  readonly owner?: 'tenant' | 'deployment';
}

/**
 * - `oidc`: an OpenID Connect identity provider people sign in with
 *   (Okta, Entra ID, Google, Keycloak…): an `issuer`, the endpoints come
 *   from its discovery document.
 * - `saml`: a SAML 2.0 identity provider people sign in with.
 * - `oauth2`: a plain OAuth 2.0 provider that isn't OpenID Connect (e.g.
 *   GitHub), with its endpoints given. Pick `oidc` for any provider that
 *   speaks OpenID Connect.
 */
export type IdentityProviderKind = 'oauth2' | 'oidc' | 'saml';

/**
 * An identity provider's configuration: one shape per `kind`. Narrow on
 * `kind` before reading kind-specific fields (`clientId`,
 * `tokenEndpoint`, `idpMetadataXml`…).
 */
export type ProviderConfig = OAuth2ProviderConfig | OidcProviderConfig | SamlProviderConfig;

/** What every kind of identity provider has. */
export interface ProviderConfigBase {
  /** Stable string chosen by the tenant (e.g. `acme-sso`, `globex-oidc`). */
  readonly providerId: string;
  readonly kind: IdentityProviderKind;
  /** The name a sign-in page shows ("Sign in with …"). Default: `providerId`. */
  readonly displayName?: string;
  /**
   * The email domains whose people sign in with this provider (lowercase,
   * e.g. `acme.com`): how an email-first sign-in page finds it.
   */
  readonly domains?: readonly string[];
  /**
   * Who may sign in the first time: `invite` (default) only people a
   * tenant admin added; `domain` also anyone from one of `domains`, once
   * the deployment has verified them.
   */
  readonly join?: 'invite' | 'domain';
  /**
   * What to give the identity provider so it can send people back: set
   * by the deployment on what it returns; ignored on registration.
   */
  readonly signIn?: ProviderSignIn;
  readonly metadata?: Record<string, unknown>;
}

/** Where the identity provider sends people back to. */
export type ProviderSignIn =
  | {
      /** OIDC / OAuth 2.0: the redirect URI to allow on the provider's client. */
      readonly redirectUri: string;
    }
  | {
      /** SAML: the service provider's entity ID, as the IdP knows it. */
      readonly spEntityId: string;
      /** SAML: the assertion consumer service URL (HTTP-POST binding). */
      readonly acsUrl: string;
      /** SAML: the service provider's metadata, for IdPs that import it. */
      readonly spMetadataUrl: string;
    };

/** An OpenID Connect identity provider (sign-in). */
export interface OidcProviderConfig extends ProviderConfigBase {
  readonly kind: 'oidc';
  /** The issuer; its `/.well-known/openid-configuration` gives the endpoints. */
  readonly issuer: string;
  readonly clientId: string;
  /** Opaque pointer resolved server-side. Never a plaintext secret. */
  readonly clientSecretRef: string;
  /** Default `openid email profile`. */
  readonly scopes?: readonly string[];
  /** From discovery when absent; returned once the deployment has them. */
  readonly authorizationEndpoint?: string;
  readonly tokenEndpoint?: string;
  readonly userinfoEndpoint?: string;
  readonly jwksEndpoint?: string;
  readonly allowedRedirectUris?: readonly string[];
  readonly claimMapping?: ClaimMappingSpec;
}

/** A SAML 2.0 identity provider (sign-in). */
export interface SamlProviderConfig extends ProviderConfigBase {
  readonly kind: 'saml';
  /** The IdP's metadata XML. Or give `idpEntityId` + `idpSsoUrl` + `idpCertificates`. */
  readonly idpMetadataXml?: string;
  readonly idpEntityId?: string;
  /** The IdP's single sign-on URL (HTTP-Redirect binding). */
  readonly idpSsoUrl?: string;
  /** The IdP's signing certificates (PEM); several during a rollover. */
  readonly idpCertificates?: readonly string[];
  /**
   * Opaque pointer to the service provider's signing key (PEM), for IdPs
   * that require signed AuthnRequests. Never a plaintext key.
   */
  readonly spSigningKeyRef?: string;
  /** Opaque pointer to the key that decrypts encrypted assertions. Never a plaintext key. */
  readonly spDecryptionKeyRef?: string;
  /** Require signed assertions. Default `true`. */
  readonly wantAssertionsSigned?: boolean;
  /** Assertion attribute names. Defaults: `userId` = the NameID, `email` = `email`. */
  readonly attributeMapping?: SamlAttributeMapping;
}

export interface SamlAttributeMapping {
  readonly userId?: string;
  readonly email?: string;
  readonly displayName?: string;
}

/**
 * A plain OAuth 2.0 provider that isn't OpenID Connect (e.g. GitHub), run
 * by this package's own OAuth flow (`/v1/auth/login` + callback, with the
 * deployment's `exchangeCode`). For a provider that speaks OpenID Connect,
 * use `oidc`.
 */
export interface OAuth2ProviderConfig extends ProviderConfigBase {
  readonly kind: 'oauth2';
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

export type IdentityProviderRegisterOutcome =
  | {
      readonly kind: 'ok';
      readonly providerId: string;
      /**
       * The provider as stored: discovered endpoints, `signIn`. Absent from
       * older bindings; the route then answers with `providerId` alone.
       */
      readonly provider?: ProviderConfig;
    }
  | {
      /**
       * The deployment couldn't use the configuration: the issuer's
       * discovery failed, the SAML metadata didn't parse, a host it may
       * not reach. 422 `identity-provider-invalid`, with `message`.
       */
      readonly kind: 'invalid';
      readonly message: string;
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
