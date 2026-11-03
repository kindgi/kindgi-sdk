// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';

import { type ResourceRef, ref } from '@kindgi/authz';

import { callerRef } from '../caller.js';
import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { type Refusal, recordRefusal, refused } from './denied.js';

/** A stored conversation, as far as who may add a turn to it goes. */
export interface TurnConversation {
  /** Its agent: what a conversation from before projects is checked on. */
  readonly agentId: string;
  /** Its participant: a turn posted into it runs as them (`participantRefusal`). */
  readonly participantId?: string;
  /** Its project: absent on a conversation from before projects. */
  readonly projectId?: string;
  /** Who opened it (`user:<id>`, `service_account:<id>`): absent on old ones. */
  readonly openedBy?: string;
  /** When it was closed: absent while it's open (`closedRefusal`). */
  readonly closedAt?: string;
}

/** A turn posted into the conversation `conversationId` names. */
export interface TurnInto {
  readonly conversationId: string;
  /** The stored conversation; `null`: there is none. */
  readonly conversation: TurnConversation | null;
  /** The project the run's body names, if it names one. */
  readonly namedProjectId: string | undefined;
}

/**
 * Who may add a turn to a stored conversation, and under which project.
 * Checked before the participant rule, which would tell a caller that the
 * conversation exists.
 *   - No such conversation: `404 conversation-not-found`, before any turn
 *     starts, whether or not the caller waits for it.
 *   - A conversation belongs to one project: a turn naming another is
 *     refused, `409 conversation-project-mismatch`, naming both. One from
 *     before projects isn't compared.
 *   - With a participant, the participant rule decides (`participantRefusal`).
 *     Without one: its opener (the caller `?openedBy=me` names), or a caller
 *     with `write` on it, as acting in someone else's conversation takes.
 *     Read isn't enough: a viewer doesn't add turns.
 * What a conversation is checked on is its project, else (from before
 * projects) its agent, as reading it is. A caller who can't read it is
 * answered as if it didn't exist, byte for byte, in place of the 409, or of
 * the 403 for a conversation with no participant. With a participant, the
 * participant rule's 403 is hidden the same way where the turn is refused
 * (`hiddenOr`). Without an authorizer, the 404 and the 409 still hold.
 */
export async function turnRefusal(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  turn: TurnInto,
): Promise<Response | undefined> {
  const { conversationId, conversation, namedProjectId } = turn;
  if (conversation === null) return conversationNotFound(c, conversationId);
  const on = checkedOn(conversation);

  const { projectId } = conversation;
  if (namedProjectId !== undefined && projectId !== undefined && namedProjectId !== projectId) {
    if (await unreadable(c, authorizer, conversation))
      return conversationNotFound(c, conversationId);
    c.status(statusFor('conversation-project-mismatch') as never);
    return c.json(
      toWireError(
        {
          code: 'conversation-project-mismatch',
          message: `Conversation "${conversationId}" is in project ${projectId}; the run names project ${namedProjectId}. Name ${projectId}, or omit \`projectId\` to continue it in its own project.`,
          conversationId,
          projectId: namedProjectId,
          conversationProjectId: projectId,
        },
        requestIdOf(c),
      ),
    );
  }

  if (authorizer === undefined || conversation.participantId !== undefined) return undefined;
  const caller = callerRef(c);
  if (caller !== undefined && caller === conversation.openedBy) return undefined;
  if (await authorizer.can(c, 'write', on)) return undefined;
  const refusal: Refusal = {
    action: 'write',
    resource: ref('conversation', conversationId),
    message:
      projectId !== undefined
        ? 'Adding a turn to a conversation someone else opened takes write on its project'
        : 'Adding a turn to a conversation someone else opened takes write on its agent, as the conversation is from before projects',
    failing: 'actor',
  };
  if (await unreadable(c, authorizer, conversation)) {
    recordRefusal(c, authorizer, refusal);
    return conversationNotFound(c, conversationId);
  }
  return refused(c, authorizer, refusal);
}

/**
 * Whether the caller can't read the conversation: `read` on what it's
 * checked on (`checkedOn`), asked through the authorizer, which records the
 * decision as it records every other. Without an authorizer, everyone can.
 */
export async function unreadable(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  conversation: TurnConversation,
): Promise<boolean> {
  return authorizer !== undefined && !(await authorizer.can(c, 'read', checkedOn(conversation)));
}

/**
 * A route's refusal on a conversation it looked up by id: the answer for
 * one that doesn't exist (`conversationNotFound`) when the caller can't read
 * it, else `refusal` as it is. The refusal was recorded when it was made; a
 * caller who can read the conversation keeps its 403. Only for a caller the
 * route refused: one it lets through goes through, read or not.
 */
export async function hiddenOr(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  conversationId: string,
  conversation: TurnConversation,
  refusal: Response,
): Promise<Response> {
  return (await unreadable(c, authorizer, conversation))
    ? conversationNotFound(c, conversationId)
    : refusal;
}

/** Its project, else (from before projects) its agent: what reading it is checked on. */
function checkedOn(conversation: TurnConversation): ResourceRef {
  return conversation.projectId !== undefined
    ? ref('project', conversation.projectId)
    : ref('agent', conversation.agentId);
}

/**
 * A closed conversation takes no new turns: `409 conversation-closed`,
 * before a run is made, with `options.wait: false` too. The message is the
 * one the turn failed with at its setup when a run was made for it. Asked
 * once every rule on who may add the turn has let it through (`turnRefusal`,
 * `participantRefusal`), so a caller who can't read the conversation still
 * gets the answer for one that doesn't exist. No conversation: nothing to
 * refuse here.
 */
export function closedRefusal(
  c: Context<AppEnv>,
  conversationId: string | undefined,
  conversation: TurnConversation | null,
): Response | undefined {
  if (conversationId === undefined || conversation?.closedAt === undefined) return undefined;
  c.status(statusFor('conversation-closed') as never);
  return c.json(
    toWireError(
      {
        code: 'conversation-closed',
        message: `Conversation "${conversationId}" is closed`,
        conversationId,
      },
      requestIdOf(c),
    ),
  );
}

/**
 * The answer for a conversation that doesn't exist: every route that looks
 * one up by id answers a missing one, and one the caller can't read, with
 * it, so the two are the same byte for byte whatever the binding says.
 */
export function conversationNotFound(c: Context<AppEnv>, conversationId: string): Response {
  c.status(statusFor('conversation-not-found') as never);
  return c.json(
    toWireError(
      {
        code: 'conversation-not-found',
        message: `No conversation with id "${conversationId}"`,
        conversationId,
      },
      requestIdOf(c),
    ),
  );
}

function requestIdOf(c: Context<AppEnv>): string {
  const requestId = c.get('requestId');
  return typeof requestId === 'string' ? requestId : '';
}
