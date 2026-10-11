// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  MintSystemKeyBody,
  MintSystemKeyResult,
  SystemKeyList,
  SystemKey as SystemKeyWire,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type SystemKey = SystemKeyWire;
export type SystemKeySpec = MintSystemKeyBody;
export type MintedSystemKey = MintSystemKeyResult;

/**
 * The operator's system keys (`kgi_sy_…`), on a runtime serving many
 * tenants. A system key acts in no tenant, with the least system scope its
 * service needs. Only the full system capability (`kindgi:system`) mints,
 * lists or revokes them; any other caller gets 403
 * (`system-principal-required`, `system-scope-missing`).
 */
export interface SystemKeysClient {
  /**
   * Mints a system key. The plaintext `token` is returned here only. A key
   * can't outlive the key minting it (`token-expiry-exceeds-minter`).
   *
   * @wire `POST /v1/system/keys`
   */
  mint(
    spec: SystemKeySpec,
    options?: { readonly idempotencyKey?: string },
  ): Promise<MintedSystemKey>;
  /**
   * Every system key, newest first, revoked ones too. Never secrets.
   *
   * @wire `GET /v1/system/keys`
   */
  list(): Promise<readonly SystemKey[]>;
  /**
   * Revokes a system key: it stops working on the next request.
   *
   * @wire `POST /v1/system/keys/{keyId}/revoke`
   */
  revoke(keyId: string, options?: { readonly idempotencyKey?: string }): Promise<SystemKey>;
}

export function makeSystemKeysClient(transport: Transport): SystemKeysClient {
  return {
    async mint(spec, options) {
      return transport.request<MintedSystemKey>({
        method: 'POST',
        path: '/v1/system/keys',
        body: spec,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async list() {
      const page = await transport.request<SystemKeyList>({
        method: 'GET',
        path: '/v1/system/keys',
      });
      return page.data;
    },
    async revoke(keyId, options) {
      return transport.request<SystemKey>({
        method: 'POST',
        path: `/v1/system/keys/${encodeURIComponent(keyId)}/revoke`,
        body: {},
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
  };
}
