// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';

import { ref } from '@kindgi/authz';

import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { refused } from './denied.js';

/**
 * Who a turn may run as. A turn runs with its participant's memory: their
 * `same-user` facts and earlier conversations are read into it, returned in
 * its result, and what it remembers is kept as theirs. So running as a
 * participant takes exactly what reading their memory takes, the memory
 * API's own rule:
 *   - the participant is the caller: a person, by their user id (never a
 *     service account's key, even one naming a user); or
 *   - the caller holds `write` on the turn's project, acting for all its end
 *     users (an app's service account, an editor).
 * Anything else is refused, 403 `participant-not-allowed`, and recorded as
 * every refusal the API decides itself is. No participant: nothing to check.
 * Without an authorizer, nothing is checked, as everywhere else.
 */
export async function participantRefusal(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  participantId: string | undefined,
  projectId: string | undefined,
): Promise<Response | undefined> {
  if (authorizer === undefined || participantId === undefined) return undefined;
  const person = c.get('serviceAccountId') === undefined ? c.get('userId') : undefined;
  if (person !== undefined && (person as unknown as string) === participantId) return undefined;
  if (projectId !== undefined && (await authorizer.can(c, 'write', ref('project', projectId)))) {
    return undefined;
  }
  const tenantId = c.get('tenantId') as unknown as string;
  return refused(c, authorizer, {
    action: 'write',
    resource: projectId !== undefined ? ref('project', projectId) : ref('tenant', tenantId),
    message:
      projectId !== undefined
        ? `Running as participant ${participantId} reads and keeps their memory, which takes write on project ${projectId} (as the memory API does), unless the participant is you`
        : `Running as participant ${participantId} reads and keeps their memory, and the turn's project isn't known, so only the participant themselves may`,
    failing: 'actor',
    code: 'participant-not-allowed',
  });
}
