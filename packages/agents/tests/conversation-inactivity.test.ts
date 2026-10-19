// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An agent's `conversationPolicy.autoCloseAfterInactiveSeconds` closes a
 * conversation nothing has been said in for that long (`autoCloseDue`),
 * since its last message, or its opening before any. A turn that starts
 * or resumes in one closes it (as its policy, `AUTO_CLOSE_ACTOR`) and
 * fails as a turn into a closed one does, unless a message reached it
 * since it was read.
 */

import type { Semver, TenantId, Timestamp } from '@kindgi/types';
import { describe, expect, test } from 'vitest';

import type { ConversationBinding, ConversationClose } from '../src/conversation-binding.js';
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

  test('due once nothing has been said for the whole window, to the millisecond', () => {
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

  test('inactive since its last message, or its opening before any', () => {
    expect(inactiveSince({ openedAt: at(600), lastMessageAt: at(30) })).toEqual(new Date(at(30)));
    expect(inactiveSince({ openedAt: at(600) })).toEqual(new Date(at(600)));
    // Opened long ago, spoken in just now: not due.
    expect(autoCloseDue({ openedAt: at(600), lastMessageAt: at(30) }, policy, NOW)).toBe(undefined);
    // Opened long ago and never spoken in: due.
    expect(autoCloseDue({ openedAt: at(600) }, policy, NOW)?.since).toEqual(new Date(at(600)));
  });

  test('never with no policy, or once closed', () => {
    const idle = { openedAt: at(86_400) };
    expect(autoCloseDue(idle, undefined, NOW)).toBe(undefined);
    expect(autoCloseDue(idle, {}, NOW)).toBe(undefined);
    expect(autoCloseDue({ ...idle, closedAt: at(10) }, policy, NOW)).toBe(undefined);
  });
});

interface Closing {
  readonly tenantId: TenantId;
  readonly id: string;
  readonly runBinding: unknown;
  readonly close: ConversationClose | undefined;
}

/** A turn into `stored`, its agent with `policy`; the binding closes it, or answers `closes`. */
function turnInto(
  stored: Partial<Conversation>,
  {
    policy,
    closes = 'closed',
  }: {
    policy?: ConversationPolicy;
    closes?: 'closed' | 'open' | 'fails';
  } = {},
) {
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
  const closing: Closing[] = [];
  const runBinding = { name: 'the run binding' };
  const conversationBinding = {
    getConversation: async () => ({ kind: 'ok', value: conversation }),
    closeConversation: async (
      t: TenantId,
      id: string,
      runs: unknown,
      close?: ConversationClose,
    ) => {
      closing.push({ tenantId: t, id, runBinding: runs, close });
      if (closes === 'fails') {
        return { kind: 'err', error: { code: 'internal', message: 'the database is busy' } };
      }
      return {
        kind: 'ok',
        value:
          closes === 'closed'
            ? { ...conversation, closedAt: new Date().toISOString() }
            : { ...conversation, lastMessageAt: new Date().toISOString() },
      };
    },
  } as unknown as ConversationBinding;
  const ctx = {
    input: { tenantId, conversationId: 'conv-1', agent: agent.value },
    bindings: { conversationBinding, runBinding },
  } as unknown as TurnContext;
  return { ctx, closing, runBinding };
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

const closedFailure = {
  code: 'conversation-closed',
  message: 'Conversation "conv-1" is closed',
  conversationId: 'conv-1',
};

describe('a turn into a conversation its policy closes', () => {
  test('past its window: the turn closes it, as its policy, and fails as for a closed one', async () => {
    const { ctx, closing, runBinding } = turnInto(
      { lastMessageAt: ago(120) },
      { policy: { autoCloseAfterInactiveSeconds: 60 } },
    );
    expect(await failureOf(loadTurnConversation(ctx))).toEqual(closedFailure);
    expect(closing).toEqual([
      {
        tenantId,
        id: 'conv-1',
        // Its runs' pending waits are cancelled with it.
        runBinding,
        close: { actor: AUTO_CLOSE_ACTOR, afterInactiveSeconds: 60 },
      },
    ]);
    expect(AUTO_CLOSE_ACTOR).toBe('system:conversation-auto-close');
  });

  test('never spoken in, past its window since it opened: the same', async () => {
    const { ctx, closing } = turnInto(
      { openedAt: ago(120) },
      { policy: { autoCloseAfterInactiveSeconds: 60 } },
    );
    expect(await failureOf(loadTurnConversation(ctx))).toEqual(closedFailure);
    expect(closing).toHaveLength(1);
  });

  test('within its window: the turn runs in it, and nothing is closed', async () => {
    const { ctx, closing } = turnInto(
      { lastMessageAt: ago(30) },
      { policy: { autoCloseAfterInactiveSeconds: 60 } },
    );
    const conversation = await loadTurnConversation(ctx);
    expect(conversation.id).toBe('conv-1');
    expect(ctx.conversation).toBe(conversation);
    expect(closing).toEqual([]);
  });

  test('no policy: however long it has been, nothing is closed', async () => {
    const { ctx, closing } = turnInto({ lastMessageAt: ago(86_400 * 30) });
    await loadTurnConversation(ctx);
    expect(closing).toEqual([]);
  });

  test('a message reached it since it was read: the binding leaves it open, and the turn runs', async () => {
    const { ctx, closing } = turnInto(
      { lastMessageAt: ago(120) },
      { policy: { autoCloseAfterInactiveSeconds: 60 }, closes: 'open' },
    );
    const conversation = await loadTurnConversation(ctx);
    expect(conversation.closedAt).toBe(undefined);
    expect(ctx.conversation).toBe(conversation);
    expect(closing).toHaveLength(1);
  });

  test("a close that fails fails the turn with the binding's error", async () => {
    const { ctx } = turnInto(
      { lastMessageAt: ago(120) },
      { policy: { autoCloseAfterInactiveSeconds: 60 }, closes: 'fails' },
    );
    expect(await failureOf(loadTurnConversation(ctx))).toEqual({
      code: 'internal',
      message: 'the database is busy',
    });
  });

  test('closed already: it fails as before, and nothing is closed again', async () => {
    const { ctx, closing } = turnInto(
      { lastMessageAt: ago(120), closedAt: ago(60) },
      { policy: { autoCloseAfterInactiveSeconds: 60 } },
    );
    expect(await failureOf(loadTurnConversation(ctx))).toEqual(closedFailure);
    expect(closing).toEqual([]);
  });

  test("another version's conversation fails on the version, not its inactivity: its policy isn't this one", async () => {
    const { ctx, closing } = turnInto(
      { lastMessageAt: ago(120), agentVersion: '0.9.0' as Semver },
      { policy: { autoCloseAfterInactiveSeconds: 60 } },
    );
    expect((await failureOf(loadTurnConversation(ctx))).code).toBe('agent-version-mismatch');
    expect(closing).toEqual([]);
  });
});
