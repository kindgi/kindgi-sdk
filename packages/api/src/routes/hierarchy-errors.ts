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
        : `Another ${resource} in the tenant has the slug "${slug}"`,
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

/** `409 project-default-already-exists`: the tenant has a Default project. */
export function projectDefaultAlreadyExistsError() {
  return {
    code: 'project-default-already-exists',
    message: 'The tenant already has a Default project',
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
