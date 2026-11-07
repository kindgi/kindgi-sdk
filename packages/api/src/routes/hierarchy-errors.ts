// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Wire errors the tenant-hierarchy routes (orgs, teams, projects) share,
 * so a conflict reads the same whichever route or write path (with or
 * without an authorizer) produced it.
 */

/** A hierarchy resource, as its wire errors name it. */
export type HierarchyResource = 'org' | 'team' | 'project';

/**
 * `409 slug-conflict`: another `resource` has `slug` where it must be
 * unique. An org's and a team's slug are unique in the tenant; a
 * project's in its org, and a project without an org's among the
 * projects without one.
 */
export function slugConflictError(resource: HierarchyResource, slug: string) {
  return {
    code: 'slug-conflict',
    message:
      resource === 'project'
        ? `Another project in its org has the slug "${slug}" (for a project without an org: another project without one)`
        : `Another ${resource} in the workspace has the slug "${slug}"`,
    resource,
    slug,
  } as const;
}

/**
 * `409 slug-conflict` on deleting an org: its projects would leave it
 * with `slugs` that projects without an org already have.
 */
export function orgDeleteSlugConflictError(slugs: readonly string[]) {
  const named = slugs.map((s) => `"${s}"`).join(', ');
  return {
    code: 'slug-conflict',
    message: `Deleting the org would leave its projects ${named} without an org, where other projects already have those slugs. Rename or move them first.`,
    resource: 'project',
    slugs,
  } as const;
}

/**
 * `404 org-not-found`: the org a project or team would be in isn't the
 * tenant's (it never existed, or it was deleted). The code and message
 * `GET /v1/orgs/{id}` answers (T220).
 */
export function orgNotFoundError(orgId: string) {
  return { code: 'org-not-found', message: `No org with id "${orgId}"`, orgId } as const;
}

/** `409 project-default-already-exists`: the tenant has a default project. */
export function projectDefaultAlreadyExistsError() {
  return {
    code: 'project-default-already-exists',
    message: 'The workspace already has a default project',
  } as const;
}

/**
 * `409 project-test-already-exists`: the person a new test project is for
 * already has one in the workspace. A person has one at most.
 */
export function projectTestAlreadyExistsError() {
  return {
    code: 'project-test-already-exists',
    message: 'You already have a test project in this workspace',
  } as const;
}

/**
 * `403 project-test-not-yours`: a test project is made by the person it's
 * for, on their own: `testFor` must be the caller's own user id, and a key
 * limited to a project makes none.
 */
export function projectTestNotYoursError(why: string) {
  return { code: 'project-test-not-yours', message: why } as const;
}

/**
 * `409 project-test-needs-isolated-runtime`: this runtime doesn't hold test
 * projects. A test project's runs reach only what's made in it, which needs
 * a runtime that refuses its tenants the private networks and the server's
 * own credentials: `KINDGI_TENANT_HOST_ACCESS=isolated`.
 */
export function projectTestNeedsIsolatedRuntimeError() {
  return {
    code: 'project-test-needs-isolated-runtime',
    message:
      "This runtime doesn't hold test projects: they need KINDGI_TENANT_HOST_ACCESS=isolated, which refuses tenants the private networks and the server's own credentials",
  } as const;
}

/**
 * `409 project-is-a-test-project`: the change isn't one a person's own test
 * project takes. Nobody else joins it, it moves into no org, it never goes
 * into production, and it's in no environment order and has no repo
 * connection. `why` says which.
 */
export function projectIsATestProjectError(projectId: string, why: string) {
  return { code: 'project-is-a-test-project', message: why, projectId } as const;
}

/**
 * `409 project-in-environment-order`: the project is a member of an
 * environment order, so it can't be deleted or moved to another parent.
 * Clear it from the order first. The answer names the order (`details.orderId`).
 */
export function projectInEnvironmentOrderError(orderId: string) {
  return {
    code: 'project-in-environment-order',
    message:
      'The project is a member of an environment order; clear it from the order before deleting or moving it.',
    orderId,
  } as const;
}

/**
 * `409 org-has-environment-order`: the org is the parent of an environment
 * order, so deleting it would orphan the order. A tenant admin clears the
 * order first (`PUT /v1/environment-orders/orgs/{orgId}` with `[]`). The
 * answer names the order (`details.orderId`).
 */
export function orgHasEnvironmentOrderError(orderId: string) {
  return {
    code: 'org-has-environment-order',
    message:
      'The org is the parent of an environment order; clear the order before deleting the org.',
    orderId,
  } as const;
}

/**
 * `501 authz-membership-unsupported`: authorization is enforced, but the
 * tenant-hierarchy binding can't change a membership together with its
 * authorization tuple (it has no `method`). Nothing is changed: removing
 * the row alone would leave the user's permission in place.
 */
export function membershipNotKeptInStepError(method: string) {
  return {
    code: 'authz-membership-unsupported',
    message: `This runtime can't keep permissions in step with a membership change (its tenant-hierarchy binding has no ${method}), so nothing was changed.`,
    method,
  } as const;
}

/**
 * Re-adding a member with another role: they keep the role they hold,
 * which the answer names (`details.role`), and nothing is written.
 */
export function membershipExistsError(role: string) {
  return {
    code: 'membership-exists',
    message: `They're a member already, as ${role}: change their role to give them another`,
    role,
  } as const;
}
