// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';

import { ref } from '@kindgi/authz';

import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { refused } from './denied.js';

/** Who a turn runs as, and where its memory is. */
export interface TurnParticipant {
  /** The turn's participant: a conversation's stored one, else the body's. */
  readonly participantId: string | undefined;
  /** The project the turn runs with: the conversation's, the named one, or the target's own. */
  readonly projectId: string | undefined;
  /**
   * The conversation the turn posts into, when there is one. Its participant
   * and project came from it, and a caller refused here may not read it, so
   * the answer names neither, only the conversation the caller sent.
   */
  readonly conversationId?: string | undefined;
}

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
 * No project known: only the participant themselves. Without an authorizer,
 * nothing is checked, as everywhere else.
 */
export async function participantRefusal(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  turn: TurnParticipant,
): Promise<Response | undefined> {
  const { participantId, projectId, conversationId } = turn;
  if (authorizer === undefined || participantId === undefined) return undefined;
  const person = c.get('serviceAccountId') === undefined ? c.get('userId') : undefined;
  if (person !== undefined && (person as unknown as string) === participantId) return undefined;
  if (projectId !== undefined && (await authorizer.can(c, 'write', ref('project', projectId)))) {
    return undefined;
  }
  const tenantId = c.get('tenantId') as unknown as string;
  return refused(c, authorizer, {
    action: 'write',
    resource:
      conversationId !== undefined
        ? ref('conversation', conversationId)
        : projectId !== undefined
          ? ref('project', projectId)
          : ref('tenant', tenantId),
    message: refusalMessage(turn),
    failing: 'actor',
    code: 'participant-not-allowed',
  });
}

function refusalMessage({ participantId, projectId, conversationId }: TurnParticipant): string {
  if (conversationId !== undefined) {
    return projectId !== undefined
      ? "Posting into this conversation runs the turn as its participant, reading and keeping their memory, which takes write on the turn's project (as the memory API does), unless the participant is you"
      : "Posting into this conversation runs the turn as its participant, reading and keeping their memory, and the turn's project isn't known, so only the participant themselves may";
  }
  return projectId !== undefined
    ? `Running as participant ${participantId} reads and keeps their memory, which takes write on project ${projectId} (as the memory API does), unless the participant is you`
    : `Running as participant ${participantId} reads and keeps their memory, and the turn's project isn't known, so only the participant themselves may`;
}
