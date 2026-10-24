// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  MintSystemKeyBody,
  MintSystemKeyResult,
  RevokeSystemKeyResult,
  SystemKeyList,
  SystemWhoami,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

/** A system key, as listed: never its secret. */
export type SystemKey = SystemKeyList['data'][number];
export type SystemKeySpec = MintSystemKeyBody;
export type MintedSystemKey = MintSystemKeyResult;
export type RevokedSystemKey = RevokeSystemKeyResult;
export type SystemKeyIdentity = SystemWhoami;

/**
 * The operator's system keys (`kgi_sy_…`). A system key acts in no tenant,
 * with the least system scope its service needs. Only the full system
 * capability (`kindgi:system`) mints, lists or revokes them; any other
 * caller gets 403 (`system-principal-required`, `system-scope-missing`).
 * On a runtime serving one tenant, only the deployment's own token does,
 * and a key holds `system:license` alone, for the license renewal: a mint
 * asking for any other scope gets 400 (`bad-input`).
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
   * Revokes a system key and every key minted from it (`alsoRevoked`): they
   * stop working on the next request.
   *
   * @wire `POST /v1/system/keys/{keyId}/revoke`
   */
  revoke(keyId: string, options?: { readonly idempotencyKey?: string }): Promise<RevokedSystemKey>;
  /**
   * Which system key this client holds: its id, scopes and expiry. Any
   * system key.
   *
   * @wire `GET /v1/system/whoami`
   */
  whoami(): Promise<SystemKeyIdentity>;
}

export function makeSystemKeysClient(transport: Transport): SystemKeysClient {
  return {
    async whoami() {
      return transport.request<SystemKeyIdentity>({ method: 'GET', path: '/v1/system/whoami' });
    },
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
      return transport.request<RevokedSystemKey>({
        method: 'POST',
        path: `/v1/system/keys/${encodeURIComponent(keyId)}/revoke`,
        body: {},
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
  };
}
