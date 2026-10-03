// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Auth — OAuth 2.0 / OIDC providers + session flow.
 *
 * @wire /v1/auth/*  (packages/api/src/routes/auth.ts)
 * @generated Wire shapes from `../generated/api.js`.
 *
 * Two audiences:
 *   - Admin: `providers.list/register/unregister` — tenant admins
 *     manage the identity-provider catalog (Google / Okta / bespoke
 *     OIDC).
 *   - Session flow: `login/callback/refresh/logout` — walk a caller
 *     through the OAuth redirect flow and issue framework session tokens.
 *     `whoami` lives on `client.identity.whoami`.
 *
 * NOTE: `login` returns an `AuthorizationResponse` with the URL to
 * redirect a browser to. `callback` exchanges the provider's code for
 * a framework session token — usually called by a browser handler
 * bridging the redirect back, not by machine-to-machine callers.
 */

import type {
  AuthorizationResponse,
  CallbackBody,
  CallbackResult,
  IdentityProviderCollectionPage,
  IdentityProviderConfig,
  LoginBody,
  LogoutResult,
  RefreshResult,
  RegisterIdentityProviderResult,
  UnregisterIdentityProviderResult,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type IdentityProviderPage = IdentityProviderCollectionPage;
export type IdentityProviderRegisterInput = IdentityProviderConfig;
export type IdentityProviderRegisterOutcome = RegisterIdentityProviderResult;
export type IdentityProviderUnregisterOutcome = UnregisterIdentityProviderResult;
export type LoginInput = LoginBody;
export type LoginResult = AuthorizationResponse;
export type CallbackInput = CallbackBody;
export type CallbackResultShape = CallbackResult;
export type RefreshResultShape = RefreshResult;
export type LogoutResultShape = LogoutResult;

export interface AuthClient {
  readonly providers: AuthProvidersClient;
  /**
   * Initiate an OAuth login flow. Returns the URL to redirect the
   * browser to. Machine-to-machine callers typically don't use this
   * — use bearer tokens instead.
   * @wire POST /v1/auth/login/:providerId
   */
  login(
    providerId: string,
    input?: LoginInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<LoginResult>;
  /**
   * Exchange a provider callback (code + state) for a framework
   * session token. Called by the browser handler receiving the
   * provider redirect.
   * @wire POST /v1/auth/callback/:providerId
   */
  callback(providerId: string, input: CallbackInput): Promise<CallbackResultShape>;
  /**
   * Refresh the current session token. Requires a session bearer.
   * @wire POST /v1/auth/refresh
   */
  refresh(options?: { readonly idempotencyKey?: string }): Promise<RefreshResultShape>;
  /**
   * Revoke the current session token. Requires a session bearer;
   * 400 if called with a plain API bearer.
   * @wire POST /v1/auth/logout
   */
  logout(options?: { readonly idempotencyKey?: string }): Promise<LogoutResultShape>;
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
}

export function makeAuthClient(transport: Transport): AuthClient {
  const seg = (s: string): string => encodeURIComponent(s);
  return {
    providers: {
      async list() {
        return transport.request<IdentityProviderPage>({
          method: 'GET',
          path: '/v1/auth/providers',
        });
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
    },
    async login(providerId, input, options) {
      return transport.request<LoginResult>({
        method: 'POST',
        path: `/v1/auth/login/${seg(providerId)}`,
        ...(input !== undefined && { body: input }),
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async callback(providerId, input) {
      return transport.request<CallbackResultShape>({
        method: 'POST',
        path: `/v1/auth/callback/${seg(providerId)}`,
        body: input,
      });
    },
    async refresh(options) {
      return transport.request<RefreshResultShape>({
        method: 'POST',
        path: '/v1/auth/refresh',
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
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
