// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Teams — operational working groups within a tenant, with membership.
 *
 * @wire /v1/teams/*  (packages/api/src/routes/teams.ts)
 * @generated Wire shapes from `../generated/api.js`.
 */

import type {
  AddTeamMembershipBody,
  AddTeamMembershipResult,
  CreateResourceResult,
  TeamCollectionPage,
  TeamMembershipCollectionPage,
  TeamPatch as TeamPatchBody,
  TeamRole as TeamRoleWire,
  TeamSpec as TeamSpecBody,
  Team as TeamWire,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type TeamShape = TeamWire;
export type TeamRecordShape = TeamShape;
export type TeamPage = TeamCollectionPage;
export type CreateTeamInput = TeamSpecBody;
export type UpdateTeamInput = TeamPatchBody;
export type TeamMembershipPage = TeamMembershipCollectionPage;
export type AddMembershipInput = AddTeamMembershipBody;
export type AddMembershipResult = AddTeamMembershipResult;
export type TeamRoleValue = TeamRoleWire;

export interface ListTeamsFilter {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListMembershipsFilter {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface TeamsClient {
  /** @wire POST /v1/teams */
  create(
    input: CreateTeamInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<CreateResourceResult>;
  /** @wire GET /v1/teams */
  list(filter?: ListTeamsFilter): Promise<TeamPage>;
  /** @wire GET /v1/teams/:teamId */
  get(teamId: string): Promise<TeamShape>;
  /** @wire PATCH /v1/teams/:teamId */
  update(
    teamId: string,
    input: UpdateTeamInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<TeamShape>;
  /** @wire DELETE /v1/teams/:teamId */
  delete(teamId: string): Promise<void>;
  readonly memberships: TeamMembershipsClient;
}

export interface TeamMembershipsClient {
  /** @wire GET /v1/teams/:teamId/memberships */
  list(teamId: string, filter?: ListMembershipsFilter): Promise<TeamMembershipPage>;
  /** @wire POST /v1/teams/:teamId/memberships */
  add(
    teamId: string,
    input: AddMembershipInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<AddMembershipResult>;
  /** @wire PATCH /v1/teams/:teamId/memberships/:userId */
  updateRole(
    teamId: string,
    userId: string,
    role: TeamRoleValue,
    options?: { readonly idempotencyKey?: string },
  ): Promise<void>;
  /** @wire DELETE /v1/teams/:teamId/memberships/:userId */
  remove(
    teamId: string,
    userId: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<void>;
}

export function makeTeamsClient(transport: Transport): TeamsClient {
  const seg = (s: string): string => encodeURIComponent(s);
  return {
    async create(input, options) {
      return transport.request<CreateResourceResult>({
        method: 'POST',
        path: '/v1/teams',
        body: input,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async list(filter) {
      return transport.request<TeamPage>({
        method: 'GET',
        path: '/v1/teams',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
        },
      });
    },
    async get(teamId) {
      return transport.request<TeamShape>({
        method: 'GET',
        path: `/v1/teams/${seg(teamId)}`,
      });
    },
    async update(teamId, input, options) {
      return transport.request<TeamShape>({
        method: 'PATCH',
        path: `/v1/teams/${seg(teamId)}`,
        body: input,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async delete(teamId) {
      return transport.request<void>({
        method: 'DELETE',
        path: `/v1/teams/${seg(teamId)}`,
        discardResponse: true,
      });
    },
    memberships: {
      async list(teamId, filter) {
        return transport.request<TeamMembershipPage>({
          method: 'GET',
          path: `/v1/teams/${seg(teamId)}/memberships`,
          query: {
            ...(filter?.limit !== undefined && { limit: filter.limit }),
            ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          },
        });
      },
      async add(teamId, input, options) {
        return transport.request<AddMembershipResult>({
          method: 'POST',
          path: `/v1/teams/${seg(teamId)}/memberships`,
          body: input,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
      async updateRole(teamId, userId, role, options) {
        return transport.request<void>({
          method: 'PATCH',
          path: `/v1/teams/${seg(teamId)}/memberships/${seg(userId)}`,
          body: { role },
          discardResponse: true,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
      async remove(teamId, userId, options) {
        return transport.request<void>({
          method: 'DELETE',
          path: `/v1/teams/${seg(teamId)}/memberships/${seg(userId)}`,
          discardResponse: true,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
    },
  };
}
