// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Wire errors the tenant-hierarchy routes (orgs, teams, projects) share,
 * so a conflict reads the same whichever route or write path (with or
 * without an authorizer) produced it.
 */

/** A hierarchy resource, as its wire errors name it. */
export type HierarchyResource = 'org' | 'team' | 'project';

/** `409 slug-conflict`: another `resource` in the tenant has `slug`. */
export function slugConflictError(resource: HierarchyResource, slug: string) {
  return {
    code: 'slug-conflict',
    message: `Another ${resource} in the tenant has the slug "${slug}"`,
    resource,
    slug,
  } as const;
}

/** `409 project-default-already-exists`: the tenant has a Default project. */
export function projectDefaultAlreadyExistsError() {
  return {
    code: 'project-default-already-exists',
    message: 'The tenant already has a Default project',
  } as const;
}
