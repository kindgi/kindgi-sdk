// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, EnvName } from '@kindgi/types';

import type { EnvCloudSecret, EnvCloudSecretPage } from '../generated/api.js';
import type { ScopeRef } from '../scope-wire.js';
import { scopeToQuery } from '../scope-wire.js';
import type { Transport } from '../transport.js';
import { tryReadRevisionConflict } from './env.js';

export type { EnvCloudSecret, EnvCloudSecretPage };

/** Where a cloud secret is set: a tenant, one of its scopes, an env and a name. */
export interface SystemCloudSecretKey {
  readonly tenantId: string;
  readonly scope: ScopeRef;
  readonly envName: EnvName;
  readonly name: string;
}

export interface SystemCloudSecretSetInput extends SystemCloudSecretKey {
  /** `projects/<project>/secrets/<secret>/versions/<number>`. */
  readonly cloudSecret: string;
  /** Set only if the stored one is at this revision. */
  readonly ifRevision?: number;
}

export interface SystemCloudSecretListInput {
  readonly tenantId: string;
  readonly scope: ScopeRef;
  readonly envName: EnvName;
  readonly cursor?: Cursor;
  readonly limit?: number;
}

/** As `env.set`'s: a changed revision is data, not an error. */
export type SystemCloudSecretSetOutcome =
  | { readonly kind: 'ok'; readonly record: EnvCloudSecret }
  | { readonly kind: 'revision-conflict'; readonly currentRevision: number };

/**
 * The operator's cloud secrets, with a system key holding
 * `system:env-refs`: an env name, at a scope of a tenant and one env, set
 * to a version of a secret the operator's cloud holds. A pack service is
 * given it by that name, and its host reads the value as the pack
 * service's own account. A runtime that keeps none (hosted, for one)
 * answers `501 cloud-secrets-unsupported`.
 */
export interface SystemEnvClient {
  /** @wire `PUT /v1/system/tenants/:tenantId/env/:name?envName=&scopeKind=&scopeId=`. */
  setCloudSecret(
    input: SystemCloudSecretSetInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<SystemCloudSecretSetOutcome>;
  /** @wire `DELETE /v1/system/tenants/:tenantId/env/:name?envName=&scopeKind=&scopeId=`. */
  deleteCloudSecret(input: SystemCloudSecretKey): Promise<{ readonly deleted: boolean }>;
  /** @wire `GET /v1/system/tenants/:tenantId/env?envName=&scopeKind=&scopeId=&cursor=&limit=`. */
  listCloudSecrets(input: SystemCloudSecretListInput): Promise<EnvCloudSecretPage>;
}

export function makeSystemEnvClient(transport: Transport): SystemEnvClient {
  const at = (input: { readonly scope: ScopeRef; readonly envName: EnvName }) => {
    const q = scopeToQuery(input.scope);
    return {
      envName: input.envName as unknown as string,
      scopeKind: q.scopeKind,
      ...(q.scopeId !== undefined && { scopeId: q.scopeId }),
    };
  };
  return {
    async setCloudSecret(input, options) {
      try {
        const record = await transport.request<EnvCloudSecret>({
          method: 'PUT',
          path: `/v1/system/tenants/${encodeURIComponent(input.tenantId)}/env/${encodeURIComponent(input.name)}`,
          query: at(input),
          body: {
            cloudSecret: input.cloudSecret,
            ...(input.ifRevision !== undefined && { ifRevision: input.ifRevision }),
          },
          ...(options?.idempotencyKey !== undefined && {
            idempotencyKey: options.idempotencyKey,
          }),
        });
        return { kind: 'ok', record };
      } catch (err) {
        const conflict = tryReadRevisionConflict(err);
        if (conflict !== null) return { kind: 'revision-conflict', currentRevision: conflict };
        throw err;
      }
    },
    async deleteCloudSecret(input) {
      return transport.request<{ readonly deleted: boolean }>({
        method: 'DELETE',
        path: `/v1/system/tenants/${encodeURIComponent(input.tenantId)}/env/${encodeURIComponent(input.name)}`,
        query: at(input),
      });
    },
    async listCloudSecrets(input) {
      return transport.request<EnvCloudSecretPage>({
        method: 'GET',
        path: `/v1/system/tenants/${encodeURIComponent(input.tenantId)}/env`,
        query: {
          ...at(input),
          ...(input.cursor !== undefined && { cursor: input.cursor as unknown as string }),
          ...(input.limit !== undefined && { limit: input.limit }),
        },
      });
    },
  };
}
