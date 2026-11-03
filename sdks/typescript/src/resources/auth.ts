// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Auth — OIDC and SAML identity providers + sessions.
 *
 * @wire /v1/auth/*  (packages/api/src/routes/auth.ts)
 * @generated Wire shapes from `../generated/api.js`.
 *
 * Two audiences:
 *   - Admin: `providers.list/get/signIn/register/update/unregister` — tenant admins
 *     manage the identity-provider catalog (Okta / Entra ID / Google /
 *     bespoke OIDC or SAML). People sign in through the deployment, which
 *     reads it; `signInOptions` says how.
 *   - Sessions: `refresh/tokenSignIn/logout`. `whoami` lives on
 *     `client.identity.whoami`.
 */

import type {
  AuthSettings,
  AuthSettingsPatch,
  EnrollSiteBody,
  EnrollSiteResult,
  IdentityProviderCollectionPage,
  IdentityProviderConfig,
  IdentityProviderKind,
  IdentityProviderSignInUrls,
  LogoutResult,
  RefreshResult,
  RegisterIdentityProviderResult,
  SignInOptions,
  SiteSignInResult,
  TokenSignInResult,
  UnregisterIdentityProviderResult,
  UpdateIdentityProviderBody,
  UpdateIdentityProviderResult,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

/** Every identity provider: the list comes whole, so `hasMore` is `false`. */
export interface IdentityProviderPage extends IdentityProviderCollectionPage {
  readonly hasMore: boolean;
}
export type IdentityProviderRegisterInput = IdentityProviderConfig;
export type IdentityProviderRegisterOutcome = RegisterIdentityProviderResult;
export type IdentityProviderUnregisterOutcome = UnregisterIdentityProviderResult;
export type IdentityProviderUpdateInput = UpdateIdentityProviderBody;
export type IdentityProviderUpdateOutcome = UpdateIdentityProviderResult;
export type IdentityProviderSignInUrlsResult = IdentityProviderSignInUrls;
export type RefreshResultShape = RefreshResult;
export type LogoutResultShape = LogoutResult;
export type SignInOptionsResult = SignInOptions;
export type TokenSignInResultShape = TokenSignInResult;
export type { AuthSettings, AuthSettingsPatch };

export interface AuthClient {
  readonly providers: AuthProvidersClient;
  /** The workspace's sign-in settings: tenant admins. */
  readonly settings: AuthSettingsClient;
  /**
   * How a person can sign in, before anyone is signed in (no credential
   * needed): the identity providers for the email's domain, each with a
   * `signInUrl` for the browser. Sign-in is email first: with no email,
   * the list is empty. `methods` says which ways in the deployment allows
   * (both `false`: nobody can sign in to the console). `legal`, when its
   * operator set them, has its terms and privacy policy for a sign-in page
   * to link; `links`, when set, the deployment's own links, in order, for
   * the console to show on every page.
   * @wire GET /v1/auth/sign-in-options
   */
  signInOptions(input?: { readonly email?: string }): Promise<SignInOptionsResult>;
  /**
   * A site posts its Ed25519 public key with the one-time enrollment code a
   * tenant admin gave it (no other credential), and learns its id and the
   * audience its statements carry. The site keeps its private key.
   * @wire POST /v1/auth/sites/enroll
   */
  enrollSite(body: EnrollSiteBody): Promise<EnrollSiteResult>;
  /**
   * A site exchanges one of its people's statements (a compact JWS it
   * signed) for a session limited to the site's project. No other
   * credential; refused with `401 site-sign-in-refused` and a `reason`.
   * @wire POST /v1/auth/site-sign-in
   */
  siteSignIn(statement: string): Promise<SiteSignInResult>;
  /**
   * Refresh the current session token. Requires a session bearer.
   * @wire POST /v1/auth/refresh
   */
  refresh(options?: { readonly idempotencyKey?: string }): Promise<RefreshResultShape>;
  /**
   * Sign in to the console with this client's API token: the runtime opens a
   * browser session and sets its cookie (useful from a browser; a server has
   * no cookie jar). Only a person's full key; refused when the deployment
   * doesn't allow it (403 `token-sign-in-off`).
   * @wire POST /v1/auth/token-sign-in
   */
  tokenSignIn(): Promise<TokenSignInResultShape>;
  /**
   * Revoke the current session token. Requires a session bearer;
   * 400 if called with a plain API bearer.
   * @wire POST /v1/auth/logout
   */
  logout(options?: { readonly idempotencyKey?: string }): Promise<LogoutResultShape>;
}

/**
 * Whether signing in takes a second factor. Mounted where the deployment
 * keeps second factors. Covers the deployment's own ways in; signing in
 * through the workspace's own identity provider is exempt, and API keys
 * aren't covered.
 */
export interface AuthSettingsClient {
  /**
   * The settings, and how many people's keys are still on the
   * deployment's previous sign-in secret, or on neither.
   *
   * @wire GET /v1/auth/settings
   */
  get(): Promise<AuthSettings>;
  /**
   * Require a second factor, or stop requiring it. Once required, a
   * session made without one ends at its next request. From a session,
   * turning it on takes one made with your own second factor
   * (`second-factor-enroll-first`).
   *
   * @wire PATCH /v1/auth/settings
   */
  update(
    patch: AuthSettingsPatch,
    options?: { readonly idempotencyKey?: string },
  ): Promise<AuthSettings>;
}

export interface AuthProvidersClient {
  /** @wire GET /v1/auth/providers */
  list(): Promise<IdentityProviderPage>;
  /** @wire POST /v1/auth/providers */
  register(
    input: IdentityProviderRegisterInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<IdentityProviderRegisterOutcome>;
  /** @wire POST /v1/auth/providers/:providerId/unregister */
  unregister(
    providerId: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<IdentityProviderUnregisterOutcome>;
  /** @wire GET /v1/auth/providers/:providerId */
  get(providerId: string): Promise<IdentityProviderConfig>;
  /**
   * What to give the identity provider so it can send people back (the
   * redirect URI, or SAML's ACS URL, entity ID and metadata URL), before
   * or after registering: the same either way. `kind` is required until
   * the provider is registered.
   * @wire GET /v1/auth/providers/:providerId/sign-in
   */
  signIn(
    providerId: string,
    input?: { readonly kind?: IdentityProviderKind },
  ): Promise<IdentityProviderSignInUrlsResult>;
  /**
   * Change a provider: a field given replaces the stored one, `null`
   * removes an optional one. Its sign-in URLs stay the same.
   * @wire PATCH /v1/auth/providers/:providerId
   */
  update(
    providerId: string,
    changes: IdentityProviderUpdateInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<IdentityProviderUpdateOutcome>;
}

export function makeAuthClient(transport: Transport): AuthClient {
  const seg = (s: string): string => encodeURIComponent(s);
  return {
    settings: {
      async get() {
        return transport.request<AuthSettings>({ method: 'GET', path: '/v1/auth/settings' });
      },
      async update(patch, options) {
        return transport.request<AuthSettings>({
          method: 'PATCH',
          path: '/v1/auth/settings',
          body: patch,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
    },
    providers: {
      async list() {
        const page = await transport.request<IdentityProviderCollectionPage>({
          method: 'GET',
          path: '/v1/auth/providers',
        });
        return { ...page, hasMore: page.hasMore ?? false };
      },
      async register(input, options) {
        return transport.request<IdentityProviderRegisterOutcome>({
          method: 'POST',
          path: '/v1/auth/providers',
          body: input,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
      async unregister(providerId, options) {
        return transport.request<IdentityProviderUnregisterOutcome>({
          method: 'POST',
          path: `/v1/auth/providers/${seg(providerId)}/unregister`,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
      async get(providerId) {
        return transport.request<IdentityProviderConfig>({
          method: 'GET',
          path: `/v1/auth/providers/${seg(providerId)}`,
        });
      },
      async signIn(providerId, input) {
        return transport.request<IdentityProviderSignInUrlsResult>({
          method: 'GET',
          path: `/v1/auth/providers/${seg(providerId)}/sign-in`,
          ...(input?.kind !== undefined && { query: { kind: input.kind } }),
        });
      },
      async update(providerId, changes, options) {
        return transport.request<IdentityProviderUpdateOutcome>({
          method: 'PATCH',
          path: `/v1/auth/providers/${seg(providerId)}`,
          body: changes,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
    },
    async signInOptions(input) {
      return transport.request<SignInOptionsResult>({
        method: 'GET',
        path: '/v1/auth/sign-in-options',
        ...(input?.email !== undefined && { query: { email: input.email } }),
      });
    },
    async enrollSite(body) {
      return transport.request<EnrollSiteResult>({
        method: 'POST',
        path: '/v1/auth/sites/enroll',
        body,
      });
    },
    async siteSignIn(statement) {
      return transport.request<SiteSignInResult>({
        method: 'POST',
        path: '/v1/auth/site-sign-in',
        body: { statement },
      });
    },
    async refresh(options) {
      return transport.request<RefreshResultShape>({
        method: 'POST',
        path: '/v1/auth/refresh',
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async tokenSignIn() {
      return transport.request<TokenSignInResultShape>({
        method: 'POST',
        path: '/v1/auth/token-sign-in',
      });
    },
    async logout(options) {
      return transport.request<LogoutResultShape>({
        method: 'POST',
        path: '/v1/auth/logout',
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
  };
}
