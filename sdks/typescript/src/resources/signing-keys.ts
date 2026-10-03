// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  RevokeSigningKeyResult as RevokeSigningKeyResultWire,
  TrustSigningKeyBody,
  TrustedSigningKeyPage,
  TrustedSigningKey as TrustedSigningKeyWire,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type TrustedSigningKey = TrustedSigningKeyWire;
export type TrustSigningKeyInput = TrustSigningKeyBody;
export type SigningKeyPage = TrustedSigningKeyPage;
export type RevokeSigningKeyResult = RevokeSigningKeyResultWire;

export interface ListSigningKeysFilter {
  readonly limit?: number;
  readonly cursor?: string;
  /** Revoked keys too. */
  readonly includeRevoked?: boolean;
  /** Prefix match on the key label. */
  readonly label?: string;
}

/**
 * Signing keys — the tenant's trust list: the public keys whose
 * signatures `POST /v1/deployments` accepts. Trusting and revoking need
 * a token with the `signing-keys:write` capability. A revoked key stays
 * readable, for audit.
 */
export interface SigningKeysClient {
  /**
   * Trust a public key (Ed25519, base64 of the 32 raw bytes) under a key
   * id that deployment envelopes name as `signerKeyId`. Trusting the
   * same key again returns it; a known id with a different key is a
   * `409 signing-key-conflict`: rotate under a new id.
   *
   * @wire `POST /v1/signing-keys`
   */
  trust(
    input: TrustSigningKeyInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<TrustedSigningKey>;

  /** @wire `GET /v1/signing-keys` */
  list(filter?: ListSigningKeysFilter): Promise<SigningKeyPage>;

  /** One key, revoked or not. @wire `GET /v1/signing-keys/{keyId}` */
  get(keyId: string): Promise<TrustedSigningKey>;

  /**
   * Stop trusting a key. Deployments it signed stay on record.
   * `revoked` is `false` when the key was unknown or already revoked.
   *
   * @wire `POST /v1/signing-keys/{keyId}/revoke`
   */
  revoke(
    keyId: string,
    input?: { readonly reason?: string },
    options?: { readonly idempotencyKey?: string },
  ): Promise<RevokeSigningKeyResult>;
}

export function makeSigningKeysClient(transport: Transport): SigningKeysClient {
  return {
    async trust(input, options) {
      return transport.request<TrustedSigningKey>({
        method: 'POST',
        path: '/v1/signing-keys',
        body: input,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async list(filter) {
      return transport.request<SigningKeyPage>({
        method: 'GET',
        path: '/v1/signing-keys',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          ...(filter?.includeRevoked === true && { includeRevoked: 'true' }),
          ...(filter?.label !== undefined && { label: filter.label }),
        },
      });
    },
    async get(keyId) {
      return transport.request<TrustedSigningKey>({
        method: 'GET',
        path: `/v1/signing-keys/${encodeURIComponent(keyId)}`,
      });
    },
    async revoke(keyId, input, options) {
      return transport.request<RevokeSigningKeyResult>({
        method: 'POST',
        path: `/v1/signing-keys/${encodeURIComponent(keyId)}/revoke`,
        body: input ?? {},
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
  };
}
