// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';

import { ref } from '@kindgi/authz';
import type { TenantId } from '@kindgi/types';

import type { Authorizer } from '../middleware/authorize.js';
import type { PersonGrantsBinding } from '../person-grants-binding.js';
import type { AppEnv } from '../types.js';
import type { Refusal } from './denied.js';

/**
 * The tenant's observer views the projects they're given and takes
 * nothing out of them: they hold no API key, make no public run link and
 * export no provenance. Those three routes ask this, and no other does.
 *
 * Nothing when the caller isn't the tenant's observer, or when there's no
 * authorizer: without one there's no observer, since the add and the
 * grant both refuse one (`observer-not-served`). Else the refusal,
 * failing `actor`, for the route to record and answer 403. `what` ends
 * the message: "mints no API keys".
 *
 * Two checks: the observer is who holds `only_view` on the tenant and not
 * `read`. `read` is what an observer never holds, so a person who is
 * somehow both a member and the observer keeps a member's rights, and a
 * member is asked only the first check. An authorizer that allows every
 * check (a stand-in, a permissive binding) refuses only a session limited
 * to a project: its ceiling takes the tenant's `read` and leaves
 * `only_view`, which asks who the principal is. That errs closed. A mint
 * asks such a session's own limit first (`limited-session-cannot-mint`); a
 * public run link and an export have no such limit, so they answer this.
 */
export async function observerRefusal(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  what: string,
): Promise<Refusal | undefined> {
  if (authorizer === undefined) return undefined;
  const tenant = ref('tenant', c.get('tenantId') as unknown as string);
  if (!(await authorizer.can(c, 'only_view', tenant))) return undefined;
  if (await authorizer.can(c, 'read', tenant)) return undefined;
  return {
    action: 'only_view',
    resource: tenant,
    message: `You're this tenant's observer: you view the projects you're given, and an observer ${what}`,
    failing: 'actor',
  };
}

/**
 * The refusal for a role the tenant's observer doesn't hold: one above
 * `viewer` on a project, or any in a team (the observer is in none).
 * Nothing when the person isn't the observer, or when the runtime keeps
 * no person grants: there's no observer then. `next` ends the message,
 * saying what the caller does instead.
 */
export async function observerRoleRefusal(
  personGrants: PersonGrantsBinding | undefined,
  tenantId: TenantId,
  userId: string,
  next: string,
): Promise<
  | { readonly code: 'person-is-observer'; readonly message: string; readonly userId: string }
  | undefined
> {
  if (personGrants === undefined) return undefined;
  const held = await personGrants.read({ tenantId, userId });
  if (held?.tenantObserver !== true) return undefined;
  return {
    code: 'person-is-observer',
    message: `${userId} is this tenant's observer, who only views: ${next}`,
    userId,
  };
}
