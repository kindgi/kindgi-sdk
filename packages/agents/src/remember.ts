// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What an agent's `remember` tool writes, decided from the agent's
 * declaration (`memory.remember`) and the run, never from the model:
 * where the fact goes, whom it's about, and whether a person approves
 * it before any read sees it.
 */

import type { Principal } from '@kindgi/authz';
import type { FactSubject, MemoryScope, RememberReviewReason } from '@kindgi/memory';
import type { ConversationId, ProjectId, TenantId, ThreadId, UserId } from '@kindgi/types';

import type { RememberPolicy, RememberScope } from './types.js';

/**
 * The built-in tool an agent that declares `memory.remember` gets. Built-in
 * ids (`kindgi_<verb>`) have no dots: the model calls exactly this name,
 * the one docs and instructions use.
 */
export const REMEMBER_TOOL_ID = 'kindgi_remember';
export const REMEMBER_TOOL_VERSION = '1.0.0';
/** Days an unverified remembered fact is kept when the agent doesn't say. */
export const DEFAULT_REMEMBER_DAYS = 30;
export const MAX_REMEMBER_DAYS = 3650;
export const MAX_REMEMBER_TEXT = 2000;
export const MAX_REMEMBER_KEY = 100;

/** The Kindgi user a run acts for: the one an agent was delegated by, or the actor. */
export function runUserId(principal: Principal | undefined): UserId | undefined {
  const user = principal?.onBehalfOf ?? principal?.actor;
  return user?.kind === 'user' ? (user.id as UserId) : undefined;
}

/** The run a remembered fact is placed by. */
export interface RememberRun {
  readonly tenantId: TenantId;
  readonly projectId?: ProjectId;
  readonly conversationId: ConversationId;
  /** The conversation's end user (the app's own id for them). */
  readonly participantId?: string;
  /** The Kindgi user the run acts for. */
  readonly userId?: UserId;
}

export type RememberTarget =
  | {
      readonly kind: 'ok';
      readonly scope: MemoryScope;
      /** Whom it came from: erasing that person erases it. */
      readonly subjects: readonly FactSubject[];
    }
  | { readonly kind: 'refused'; readonly reason: string };

/** Where a fact the agent remembers goes, and whom it's about. */
export function rememberTarget(scope: RememberScope, run: RememberRun): RememberTarget {
  const inProject = {
    tenantId: run.tenantId,
    ...(run.projectId !== undefined && { projectId: run.projectId }),
  };
  const person: FactSubject | undefined =
    run.participantId !== undefined
      ? { kind: 'participant', id: run.participantId }
      : run.userId !== undefined
        ? { kind: 'user', id: run.userId }
        : undefined;
  const subjects = person !== undefined ? [person] : [];
  const ok = (to: MemoryScope): RememberTarget => ({ kind: 'ok', scope: to, subjects });
  switch (scope) {
    case 'same-user':
      if (run.participantId !== undefined) {
        return ok({ ...inProject, participantId: run.participantId });
      }
      if (run.userId !== undefined) return ok({ ...inProject, userId: run.userId });
      return {
        kind: 'refused',
        reason:
          'Not remembered: this conversation names no end user and the run acts for no user, so there is no one to remember it for.',
      };
    case 'same-conversation':
      return ok({ ...inProject, threadId: run.conversationId as unknown as ThreadId });
    case 'same-project':
      if (run.projectId === undefined) {
        return { kind: 'refused', reason: 'Not remembered: the run has no project.' };
      }
      return ok(inProject);
    case 'tenant':
      return ok({ tenantId: run.tenantId });
  }
}

/**
 * Text that reads like an instruction to an agent, by the words and forms
 * prompt injection uses: "always" or "never", "ignore" or "disregard",
 * "you must" and the like, a system prompt or instructions, a link, or one
 * of the agent's own tools. This routes a fact to a person; it isn't the
 * defense (the scope guard, the trust label and the data block are).
 */
const INSTRUCTION_LIKE: readonly RegExp[] = [
  /\b(always|never)\b/i,
  /\b(ignore|disregard)\b/i,
  /\byou (must|should|shall|have to|need to|are required to)\b/i,
  /\b(system prompt|instructions?)\b/i,
  /\b[a-z][a-z0-9+.-]*:\/\/\S/i,
  /\bwww\.[a-z0-9-]+\.[a-z]/i,
];

export function looksLikeInstruction(text: string, toolIds: readonly string[]): boolean {
  if (INSTRUCTION_LIKE.some((pattern) => pattern.test(text))) return true;
  return toolIds.some((id) =>
    // The id, or the name a provider sees for a dotted one (`.` → `__`), as a whole token.
    [id, id.replace(/\./g, '__')].some((name) =>
      new RegExp(`(^|[^\\w.])${escapeRegExp(name)}($|[^\\w])`, 'i').test(text),
    ),
  );
}

/** Why a fact the agent remembers waits for a person; none when it's used at once. */
export function reviewReasons(
  policy: RememberPolicy,
  text: string,
  toolIds: readonly string[],
): readonly RememberReviewReason[] {
  return [
    ...(policy.scope === 'same-project' || policy.scope === 'tenant'
      ? (['wide-scope'] as const)
      : []),
    ...(looksLikeInstruction(text, toolIds) ? (['instruction-like'] as const) : []),
  ];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
