// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, EnvName } from '@kindgi/types';

import type { Transport } from '../transport.js';

/**
 * Environments resource — the env names a tenant holds anything under,
 * for a tenant admin: the `envName` that `env.list` and `secrets.list`
 * take.
 */
export interface EnvironmentsClient {
  /**
   * The env names the tenant holds an env value or a secret under, at any
   * scope, each once, in byte order. A revoked secret doesn't count. Throws
   * on `501 environments-unsupported` from a runtime whose env or secret
   * store can't list its env names.
   *
   * @wire `GET /v1/environments` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1environments/get`.
   */
  list(input?: EnvironmentsListInput): Promise<EnvironmentsPage>;
}

export interface EnvironmentsListInput {
  readonly cursor?: Cursor;
  readonly limit?: number;
}

export interface Environment {
  readonly envName: EnvName;
}

export interface EnvironmentsPage {
  readonly data: readonly Environment[];
  /** Whether there's another page (`nextCursor` names it). */
  readonly hasMore: boolean;
  readonly nextCursor?: Cursor;
}

export function makeEnvironmentsClient(transport: Transport): EnvironmentsClient {
  return {
    list(input = {}) {
      return transport.request<EnvironmentsPage>({
        method: 'GET',
        path: '/v1/environments',
        query: {
          ...(input.cursor !== undefined && { cursor: input.cursor as unknown as string }),
          ...(input.limit !== undefined && { limit: input.limit }),
        },
      });
    },
  };
}
