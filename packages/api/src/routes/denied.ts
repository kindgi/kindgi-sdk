// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';

import type { Action, ResourceRef } from '@kindgi/authz';

import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';

/**
 * An in-handler check, for a resource known only once the request is
 * read: nothing when the caller may take `action` on `resource` (or there
 * is no authorizer), else the authorizer's own 403, to return as is.
 */
export async function deniedBy(
  authorizer: Authorizer | undefined,
  c: Context<AppEnv>,
  action: Action,
  resource: ResourceRef,
): Promise<Response | undefined> {
  if (authorizer === undefined) return undefined;
  let allowed = false;
  const answer = await authorizer.authorize(action, () => resource)(c, async () => {
    allowed = true;
  });
  return allowed ? undefined : (answer as Response);
}
