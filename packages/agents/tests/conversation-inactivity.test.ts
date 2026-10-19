// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An agent's `conversationPolicy.autoCloseAfterInactiveSeconds` closes a
 * conversation nothing has happened in for that long (`autoCloseDue`): no
 * message, no turn posted or ended, since the latest of those and its
 * opening, and no run in it in flight. A turn's own run is in flight, so a
 * turn's setup, as it starts or resumes, never closes it for inactivity.
 */

import type { Semver, TenantId, Timestamp } from '@kindgi/types';
import { describe, expect, test } from 'vitest';

import type { ConversationBinding } from '../src/conversation-binding.js';
import { AUTO_CLOSE_ACTOR, autoCloseDue, inactiveSince } from '../src/conversation-inactivity.js';
import { defineAgent } from '../src/define.js';
import type { TurnContext } from '../src/handlers/context.js';
import { AgentTurnFailure } from '../src/handlers/errors.js';
import { loadTurnConversation } from '../src/handlers/turn-environment.js';
import type { AgentId, Conversation, ConversationPolicy } from '../src/types.js';

const tenantId = 't-1' as TenantId;
const NOW = new Date('2026-10-19T12:00:00.000Z');
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString() as Timestamp;

describe('autoCloseDue', () => {
  const policy = { autoCloseAfterInactiveSeconds: 60 };
  const at = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString();
  const quiet = { inFlight: false };

  test('due once nothing has happened for the whole window, to the millisecond', () => {
    const since = at(60);
    expect(autoCloseDue({ openedAt: at(600), lastMessageAt: since }, policy, NOW)).toEqual({
      since: new Date(since),
      afterSeconds: 60,
    });
    const justShort = new Date(NOW.getTime() - 59_999).toISOString();
    expect(autoCloseDue({ openedAt: at(600), lastMessageAt: justShort }, policy, NOW)).toBe(
      undefined,
    );
  });

  test('inactive since the latest of its last message, last turn posted, last run ended and opening', () => {
    const latest = at(30);
    for (const runs of [
      { ...quiet, lastPostedAt: latest, lastEndedAt: at(500) },
      { ...quiet, lastPostedAt: at(500), lastEndedAt: latest },
    ]) {
      const c = { openedAt: at(900), lastMessageAt: at(400), runs };
      expect(inactiveSince(c)).toEqual(new Date(latest));
      // Its message is old, but a turn was posted, or a run ended, just now: not due.
      expect(autoCloseDue(c, policy, NOW)).toBe(undefined);
    }
    expect(inactiveSince({ openedAt: at(600), lastMessageAt: at(30) })).toEqual(new Date(at(30)));
    // Opened long ago and nothing since: due, from its opening.
    expect(autoCloseDue({ openedAt: at(600), runs: quiet }, policy, NOW)?.since).toEqual(
      new Date(at(600)),
    );
  });

  test('a run in flight holds it open, however long nothing has happened', () => {
    const waiting = {
      openedAt: at(86_400),
      lastMessageAt: at(86_400),
      runs: { inFlight: true, lastPostedAt: at(86_400) },
    };
    expect(autoCloseDue(waiting, policy, NOW)).toBe(undefined);
    expect(
      autoCloseDue({ ...waiting, runs: { ...waiting.runs, inFlight: false } }, policy, NOW),
    ).toEqual({ since: new Date(at(86_400)), afterSeconds: 60 });
  });

  test('its runs not known: may be due by its own record, which they can only make later', () => {
    const c = { openedAt: at(600), lastMessageAt: at(120) };
    expect(autoCloseDue(c, policy, NOW)?.since).toEqual(new Date(at(120)));
    expect(
      autoCloseDue({ ...c, runs: { inFlight: false, lastEndedAt: at(10) } }, policy, NOW),
    ).toBe(undefined);
  });

  test('never with no policy, or once closed', () => {
    const idle = { openedAt: at(86_400), runs: quiet };
    expect(autoCloseDue(idle, undefined, NOW)).toBe(undefined);
    expect(autoCloseDue(idle, {}, NOW)).toBe(undefined);
    expect(autoCloseDue({ ...idle, closedAt: at(10) }, policy, NOW)).toBe(undefined);
  });

  test('the actor a close by the policy records', () => {
    expect(AUTO_CLOSE_ACTOR).toBe('system:conversation-auto-close');
  });
});

/** A turn into `stored`, its agent with `policy`; any close the binding is asked for is kept. */
function turnInto(stored: Partial<Conversation>, policy?: ConversationPolicy) {
  const agent = defineAgent({
    id: 'acme.desk' as AgentId,
    version: '1.0.0' as Semver,
    name: 'Desk',
    instructions: 'Help.',
    capabilities: [{ needs: [{ feature: 'tool-use' as const }] }],
    tools: [],
    retrieval: [],
    guardrails: [],
    ...(policy !== undefined && { conversationPolicy: policy }),
  });
  if (agent.kind === 'err') throw new Error(JSON.stringify(agent.error.issues));
  const conversation = {
    id: 'conv-1',
    tenantId,
    agentId: 'acme.desk',
    agentVersion: '1.0.0',
    title: '',
    scope: { tenantId },
    turnCount: 3,
    openedAt: ago(3600),
    ...stored,
  } as unknown as Conversation;
  const closing: unknown[] = [];
  const conversationBinding = {
    getConversation: async () => ({ kind: 'ok', value: conversation }),
    closeConversation: async (...args: unknown[]) => {
      closing.push(args);
      return { kind: 'ok', value: { ...conversation, closedAt: new Date().toISOString() } };
    },
  } as unknown as ConversationBinding;
  const ctx = {
    input: { tenantId, conversationId: 'conv-1', agent: agent.value },
    bindings: { conversationBinding, runBinding: { name: 'the run binding' } },
  } as unknown as TurnContext;
  return { ctx, closing, conversation };
}

async function failureOf(run: Promise<unknown>): Promise<AgentTurnFailure['payload']> {
  try {
    await run;
  } catch (error) {
    if (error instanceof AgentTurnFailure) return error.payload;
    throw error;
  }
  throw new Error('the turn went on');
}

describe("a turn's setup, as it starts or resumes, in a conversation past its window", () => {
  test('goes on, and closes nothing: its own run is in flight', async () => {
    // A turn resumed after an approval answered long after the window passed.
    const { ctx, closing, conversation } = turnInto(
      { lastMessageAt: ago(7200) },
      { autoCloseAfterInactiveSeconds: 60 },
    );
    expect(await loadTurnConversation(ctx)).toBe(conversation);
    expect(ctx.conversation).toBe(conversation);
    expect(closing).toEqual([]);
  });

  test('closed already, by its policy or a caller: it fails as before', async () => {
    const { ctx, closing } = turnInto(
      { lastMessageAt: ago(7200), closedAt: ago(60) },
      { autoCloseAfterInactiveSeconds: 60 },
    );
    expect(await failureOf(loadTurnConversation(ctx))).toEqual({
      code: 'conversation-closed',
      message: 'Conversation "conv-1" is closed',
      conversationId: 'conv-1',
    });
    expect(closing).toEqual([]);
  });
});
