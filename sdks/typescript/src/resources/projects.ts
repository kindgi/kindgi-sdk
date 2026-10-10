// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Projects — org-optional sub-tenants (workstreams within a tenant).
 *
 * @wire /v1/projects/*  (packages/api/src/routes/projects.ts)
 * @generated Wire shapes from `../generated/api.js`.
 */

import type {
  AddProjectMembershipBody,
  AddProjectMembershipResult,
  CreateResourceResult,
  ProjectCollectionPage,
  ProjectMembershipCollectionPage,
  ProjectPatch as ProjectPatchBody,
  ProjectRole as ProjectRoleWire,
  ProjectSpec as ProjectSpecBody,
  Project as ProjectWire,
  TeamProjectGrantCollectionPage,
  TeamProjectGrant as TeamProjectGrantWire,
  TeamProjectRole as TeamProjectRoleWire,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type ProjectShape = ProjectWire;
export type ProjectRecordShape = ProjectShape;
export type ProjectPage = ProjectCollectionPage;
export type CreateProjectInput = ProjectSpecBody;
export type UpdateProjectInput = ProjectPatchBody;
export type ProjectMembershipPage = ProjectMembershipCollectionPage;
export type AddProjectMembershipInput = AddProjectMembershipBody;
export type AddProjectMembershipOutcome = AddProjectMembershipResult;
export type ProjectRoleValue = ProjectRoleWire;

export interface ListProjectsFilter {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListProjectMembershipsFilter {
  readonly limit?: number;
  readonly cursor?: string;
}

/** A team's role on a project, with the team's and the project's names. */
export type TeamProjectGrantShape = TeamProjectGrantWire;
export type TeamProjectGrantPage = TeamProjectGrantCollectionPage;
/** `viewer`, `editor` or `admin`: a team never owns a project. */
export type TeamProjectRoleValue = TeamProjectRoleWire;

export interface ListTeamGrantsFilter {
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * The teams with a role on a project. Every member of a team holds it
 * there. Reading takes `write` on the project (its editors and admins);
 * changing takes `admin`.
 */
export interface ProjectTeamGrantsClient {
  /** @wire GET /v1/projects/:projectId/team-grants */
  list(projectId: string, filter?: ListTeamGrantsFilter): Promise<TeamProjectGrantPage>;
  /**
   * Give a team a role on the project. Takes `read` on the team too.
   * Repeating the role the team holds answers it again; another role is
   * `409 team-grant-exists` (`details.role`): change it with `updateRole`.
   *
   * @wire POST /v1/projects/:projectId/team-grants
   */
  add(
    projectId: string,
    input: { readonly teamId: string; readonly role: TeamProjectRoleValue },
    options?: { readonly idempotencyKey?: string },
  ): Promise<TeamProjectGrantShape>;
  /** @wire PATCH /v1/projects/:projectId/team-grants/:teamId */
  updateRole(
    projectId: string,
    teamId: string,
    role: TeamProjectRoleValue,
    options?: { readonly idempotencyKey?: string },
  ): Promise<void>;
  /** @wire DELETE /v1/projects/:projectId/team-grants/:teamId */
  remove(
    projectId: string,
    teamId: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<void>;
}

export interface ProjectsClient {
  /** @wire POST /v1/projects */
  create(
    input: CreateProjectInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<CreateResourceResult>;
  /** @wire GET /v1/projects */
  list(filter?: ListProjectsFilter): Promise<ProjectPage>;
  /** @wire GET /v1/projects/default — the tenant's default project */
  getDefault(): Promise<ProjectShape>;
  /** @wire GET /v1/projects/:projectId */
  get(projectId: string): Promise<ProjectShape>;
  /** @wire PATCH /v1/projects/:projectId */
  update(
    projectId: string,
    input: UpdateProjectInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<ProjectShape>;
  /** @wire DELETE /v1/projects/:projectId */
  delete(projectId: string): Promise<void>;
  readonly memberships: ProjectMembershipsClient;
  readonly teamGrants: ProjectTeamGrantsClient;
}

export interface ProjectMembershipsClient {
  /** @wire GET /v1/projects/:projectId/memberships */
  list(projectId: string, filter?: ListProjectMembershipsFilter): Promise<ProjectMembershipPage>;
  /**
   * Add a person of the tenant, named by exactly one of `userId` and
   * `email`; someone who isn't one is `404 identity-user-not-found`. The
   * outcome has their `userId`.
   *
   * @wire POST /v1/projects/:projectId/memberships
   */
  add(
    projectId: string,
    input: AddProjectMembershipInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<AddProjectMembershipOutcome>;
  /** @wire PATCH /v1/projects/:projectId/memberships/:userId */
  updateRole(
    projectId: string,
    userId: string,
    role: ProjectRoleValue,
    options?: { readonly idempotencyKey?: string },
  ): Promise<void>;
  /** @wire DELETE /v1/projects/:projectId/memberships/:userId */
  remove(
    projectId: string,
    userId: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<void>;
}

export function makeProjectsClient(transport: Transport): ProjectsClient {
  const seg = (s: string): string => encodeURIComponent(s);
  return {
    async create(input, options) {
      return transport.request<CreateResourceResult>({
        method: 'POST',
        path: '/v1/projects',
        body: input,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async list(filter) {
      return transport.request<ProjectPage>({
        method: 'GET',
        path: '/v1/projects',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
        },
      });
    },
    async getDefault() {
      return transport.request<ProjectShape>({
        method: 'GET',
        path: '/v1/projects/default',
      });
    },
    async get(projectId) {
      return transport.request<ProjectShape>({
        method: 'GET',
        path: `/v1/projects/${seg(projectId)}`,
      });
    },
    async update(projectId, input, options) {
      return transport.request<ProjectShape>({
        method: 'PATCH',
        path: `/v1/projects/${seg(projectId)}`,
        body: input,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async delete(projectId) {
      return transport.request<void>({
        method: 'DELETE',
        path: `/v1/projects/${seg(projectId)}`,
        discardResponse: true,
      });
    },
    memberships: {
      async list(projectId, filter) {
        return transport.request<ProjectMembershipPage>({
          method: 'GET',
          path: `/v1/projects/${seg(projectId)}/memberships`,
          query: {
            ...(filter?.limit !== undefined && { limit: filter.limit }),
            ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          },
        });
      },
      async add(projectId, input, options) {
        return transport.request<AddProjectMembershipOutcome>({
          method: 'POST',
          path: `/v1/projects/${seg(projectId)}/memberships`,
          body: input,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
      async updateRole(projectId, userId, role, options) {
        return transport.request<void>({
          method: 'PATCH',
          path: `/v1/projects/${seg(projectId)}/memberships/${seg(userId)}`,
          body: { role },
          discardResponse: true,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
      async remove(projectId, userId, options) {
        return transport.request<void>({
          method: 'DELETE',
          path: `/v1/projects/${seg(projectId)}/memberships/${seg(userId)}`,
          discardResponse: true,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
    },
    teamGrants: {
      async list(projectId, filter) {
        return transport.request<TeamProjectGrantPage>({
          method: 'GET',
          path: `/v1/projects/${seg(projectId)}/team-grants`,
          query: {
            ...(filter?.limit !== undefined && { limit: filter.limit }),
            ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          },
        });
      },
      async add(projectId, input, options) {
        return transport.request<TeamProjectGrantShape>({
          method: 'POST',
          path: `/v1/projects/${seg(projectId)}/team-grants`,
          body: input,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
      async updateRole(projectId, teamId, role, options) {
        return transport.request<void>({
          method: 'PATCH',
          path: `/v1/projects/${seg(projectId)}/team-grants/${seg(teamId)}`,
          body: { role },
          discardResponse: true,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
      async remove(projectId, teamId, options) {
        return transport.request<void>({
          method: 'DELETE',
          path: `/v1/projects/${seg(projectId)}/team-grants/${seg(teamId)}`,
          discardResponse: true,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
    },
  };
}
