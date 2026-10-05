// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/platform` — the multi-tenant hierarchy primitives. Ships
 * the type surface + binding interfaces (plus reference in-memory
 * adapters); durable implementations are supplied by the deployment.
 * Authorization vocabulary (object types, actions, tuple builders, PEP
 * helpers) lives in `@kindgi/authz`, not here.
 */

export type * from './scope.js';
export type * from './types.js';
export { scopeKey } from './scope.js';

export type {
  OrgBinding,
  OrgCreateOutcome,
  OrgListFilter,
  OrgDeleteConflict,
  OrgUpdateOutcome,
} from './org-binding.js';
export type {
  TeamBinding,
  TeamCreateOutcome,
  TeamListFilter,
  TeamMembershipAddInput,
  TeamMembershipAddOutcome,
  TeamMembershipBinding,
  TeamMembershipUpdateRoleOutcome,
  TeamUpdateOutcome,
} from './team-binding.js';
export type {
  ProjectBinding,
  ProjectCreateOutcome,
  ProjectListFilter,
  ProjectMembershipAddInput,
  ProjectMembershipAddOutcome,
  ProjectMembershipBinding,
  ProjectMembershipUpdateRoleOutcome,
  ProjectUpdateOutcome,
} from './project-binding.js';
export type {
  TeamProjectGrant,
  TeamProjectGrantAddInput,
  TeamProjectGrantBinding,
} from './team-project-grant-binding.js';

export {
  makeInMemoryOrgBinding,
  makeInMemoryTeamBinding,
  makeInMemoryProjectBinding,
} from './in-memory/index.js';

export type {
  AddProjectMemberError,
  AddProjectMemberParams,
  AddTeamMemberError,
  AddTeamMemberParams,
  CreateOrgError,
  CreateOrgParams,
  CreateProjectError,
  CreateProjectParams,
  CreateTeamError,
  CreateTeamParams,
  TenantHierarchyBinding,
  TenantSummary,
} from './tenant-hierarchy-binding.js';
