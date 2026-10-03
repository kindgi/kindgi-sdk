// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Orgs — structural subdivisions within a tenant.
 *
 * @wire /v1/orgs/*  (packages/api/src/routes/orgs.ts)
 * @generated Wire shapes from `../generated/api.js`.
 *
 * Distinct from teams: orgs are STRUCTURAL (a firm's litigation
 * department), teams are OPERATIONAL (a specific working group).
 * Small tenants ignore orgs; large ones use them for hierarchy.
 */

import type {
  CreateResourceResult,
  Org,
  OrgCollectionPage,
  OrgPatch as OrgPatchBody,
  OrgSpec as OrgSpecBody,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type OrgRecord = Org;
export type OrgPage = OrgCollectionPage;
export type CreateOrgInput = OrgSpecBody;
export type UpdateOrgInput = OrgPatchBody;

export interface ListOrgsFilter {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface OrgsClient {
  /** @wire POST /v1/orgs */
  create(
    input: CreateOrgInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<CreateResourceResult>;
  /** @wire GET /v1/orgs */
  list(filter?: ListOrgsFilter): Promise<OrgPage>;
  /** @wire GET /v1/orgs/:orgId */
  get(orgId: string): Promise<OrgRecord>;
  /** @wire PATCH /v1/orgs/:orgId */
  update(
    orgId: string,
    input: UpdateOrgInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<OrgRecord>;
  /** @wire DELETE /v1/orgs/:orgId */
  delete(orgId: string): Promise<void>;
}

export function makeOrgsClient(transport: Transport): OrgsClient {
  const seg = (s: string): string => encodeURIComponent(s);
  return {
    async create(input, options) {
      return transport.request<CreateResourceResult>({
        method: 'POST',
        path: '/v1/orgs',
        body: input,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async list(filter) {
      return transport.request<OrgPage>({
        method: 'GET',
        path: '/v1/orgs',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
        },
      });
    },
    async get(orgId) {
      return transport.request<OrgRecord>({
        method: 'GET',
        path: `/v1/orgs/${seg(orgId)}`,
      });
    },
    async update(orgId, input, options) {
      return transport.request<OrgRecord>({
        method: 'PATCH',
        path: `/v1/orgs/${seg(orgId)}`,
        body: input,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async delete(orgId) {
      return transport.request<void>({
        method: 'DELETE',
        path: `/v1/orgs/${seg(orgId)}`,
        discardResponse: true,
      });
    },
  };
}
