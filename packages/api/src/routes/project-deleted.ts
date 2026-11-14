// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';

import type { ProjectId, TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { AppEnv } from '../types.js';

/**
 * Whether a project is deleted (`DELETE /v1/projects/{projectId}`), and not
 * restored since: `createApp`'s `projectDeleted`.
 */
export type ProjectDeletedCheck = (tenantId: TenantId, projectId: ProjectId) => Promise<boolean>;

/**
 * A deleted project's refusal: it's gone to every caller, so `404
 * project-not-found`, as for an id with no project. Its gates ask it
 * before they ask whether the project is suspended.
 */
export function projectGoneError(projectId: ProjectId | string): {
  readonly code: 'project-not-found';
  readonly message: string;
  readonly projectId: string;
} {
  const id = projectId as unknown as string;
  return { code: 'project-not-found', message: `No project with id "${id}"`, projectId: id };
}

/** `projectGoneError` answered, when `projectDeleted` says the project is deleted. */
export async function projectGone(
  c: Context<AppEnv>,
  projectDeleted: ProjectDeletedCheck | undefined,
  tenantId: TenantId,
  projectId: ProjectId,
): Promise<Response | undefined> {
  if (projectDeleted === undefined || !(await projectDeleted(tenantId, projectId))) {
    return undefined;
  }
  c.status(statusFor('project-not-found') as never);
  return c.json(toWireError(projectGoneError(projectId), c.get('requestId')));
}
