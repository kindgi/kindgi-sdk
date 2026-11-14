// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  KeptRepoErasurePage,
  KeptRepoId,
  KeptRepoOpenErasure,
  KeptRepoPurgedBody,
  KeptRepoRuling,
  KeptRepoRulings,
  KeptRepoState,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type {
  KeptRepoErasurePage,
  KeptRepoId,
  KeptRepoOpenErasure,
  KeptRepoRuling,
  KeptRepoRulings,
  KeptRepoState,
};

/** Why a kept repo is purged, as a ruling gives it and a report repeats it. */
export type KeptRepoPurgeReason = KeptRepoPurgedBody['reason'];

/** A project's kept repo, by its tenant and project ids. */
export interface KeptRepoRef {
  readonly tenantId: string;
  readonly projectId: string;
}

/**
 * Kept repos: the repos a store keeps for the runtime's projects without
 * a GitHub repo, on a runtime serving many tenants. The store's reconcile
 * holds `system:kept-repos` (`rulings`, `erasures`, `reportPurged`); the
 * operator's erasure, `system:kept-repos:erase` (`state`,
 * `requestErasure`).
 */
export interface SystemKeptReposClient {
  /** @wire `POST /v1/system/kept-repos/rulings`. Up to 500 ids; one ruling each, in order. */
  rulings(ids: readonly KeptRepoRef[]): Promise<KeptRepoRulings>;
  /** @wire `GET /v1/system/kept-repos/erasures?limit=&cursor=`. The unfinished erasures, by tenant then project. */
  erasures(input?: {
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<KeptRepoErasurePage>;
  /** @wire `POST /v1/system/tenants/:tenantId/projects/:projectId/kept-repo/purged`. */
  reportPurged(input: KeptRepoRef & { readonly reason: KeptRepoPurgeReason }): Promise<void>;
  /** @wire `GET /v1/system/tenants/:tenantId/projects/:projectId/kept-repo`. */
  state(input: KeptRepoRef): Promise<KeptRepoState>;
  /**
   * @wire `POST /v1/system/tenants/:tenantId/projects/:projectId/kept-repo/erasure`.
   * `erasure-requested` (`202`), or `purged` (`200`) when its erasure is
   * done already.
   */
  requestErasure(
    input: KeptRepoRef,
    options?: { readonly idempotencyKey?: string },
  ): Promise<KeptRepoState>;
}

export function makeSystemKeptReposClient(transport: Transport): SystemKeptReposClient {
  return {
    async rulings(ids) {
      return transport.request<KeptRepoRulings>({
        method: 'POST',
        path: '/v1/system/kept-repos/rulings',
        body: { ids: ids.map((id) => ({ tenantId: id.tenantId, projectId: id.projectId })) },
      });
    },
    async erasures(input = {}) {
      return transport.request<KeptRepoErasurePage>({
        method: 'GET',
        path: '/v1/system/kept-repos/erasures',
        query: {
          ...(input.limit !== undefined && { limit: input.limit }),
          ...(input.cursor !== undefined && { cursor: input.cursor }),
        },
      });
    },
    async reportPurged(input) {
      return transport.request<void>({
        method: 'POST',
        path: `/v1/system/tenants/${encodeURIComponent(input.tenantId)}/projects/${encodeURIComponent(input.projectId)}/kept-repo/purged`,
        body: { reason: input.reason },
      });
    },
    async state(input) {
      return transport.request<KeptRepoState>({
        method: 'GET',
        path: `/v1/system/tenants/${encodeURIComponent(input.tenantId)}/projects/${encodeURIComponent(input.projectId)}/kept-repo`,
      });
    },
    async requestErasure(input, options) {
      return transport.request<KeptRepoState>({
        method: 'POST',
        path: `/v1/system/tenants/${encodeURIComponent(input.tenantId)}/projects/${encodeURIComponent(input.projectId)}/kept-repo/erasure`,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
  };
}
