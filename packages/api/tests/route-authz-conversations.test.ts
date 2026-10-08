// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Conversations and authorization (T243 A): reading one, its messages,
 * or the list needs `read` on its project (its agent, for one from
 * before projects); opening or closing one needs `execute` on its agent,
 * as starting a run does.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Conversation, ConversationBinding } from '@kindgi/agents';
import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import { createStubAppBindings } from '@kindgi/testing';
import type { TenantId, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'route-authz-conversations';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId } : null;
const P = randomUUID();
const AGENT = 'acme.desk';

function conversation(projectId?: string): Conversation {
  return {
    id: randomUUID(),
    tenantId,
    agentId: AGENT,
    agentVersion: '1.0.0',
    title: 't',
    ...(projectId !== undefined && { projectId }),
    scope: { tenantId },
    openedAt: '2026-10-07T08:00:00.000Z',
    turnCount: 0,
  } as unknown as Conversation;
}
const inP = conversation(P);
const legacy = conversation();

function harness(grants: readonly string[]) {
  const asked: string[] = [];
  const decide = (action: Action, r: ResourceRef): Decision => {
    asked.push(`${action} ${r.type}:${r.id}`);
    const allowed = grants.includes(`${action} ${r.type}:${r.id}`);
    return {
      allowed,
      reason: allowed ? 'test: granted' : 'test: not granted',
      evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
    };
  };
  const reached: string[] = [];
  const conversations = {
    getConversation: async (_t: TenantId, id: string) => {
      const found = [inP, legacy].find((c) => c.id === id);
      return found === undefined
        ? { kind: 'err', error: { code: 'conversation-not-found', message: 'x' } }
        : { kind: 'ok', value: found };
    },
    listConversationsPage: async () => ({
      kind: 'ok',
      value: { data: [inP, legacy], hasMore: false },
    }),
    openConversation: async () => {
      reached.push('open');
      return { kind: 'ok', value: inP };
    },
    closeConversation: async () => {
      reached.push('close');
      return { kind: 'ok', value: inP };
    },
    readMessages: async () => {
      reached.push('messages');
      return { kind: 'ok', value: [] };
    },
  } as unknown as ConversationBinding;
  const app = createApp({
    ...createStubAppBindings(),
    conversationBinding: conversations,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    authz: {
      fgaApiUrl: 'http://fga.invalid',
      authzCheckBinding: {
        check: async (_p, action, r) => decide(action, r),
        checkBatch: async (_p, action, rs) => rs.map((r) => decide(action, r)),
      } satisfies AuthzCheckBinding,
    },
  });
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  return { call, asked, reached };
}

describe('reading conversations needs read on their project (or agent)', () => {
  test('one, and its messages: 403 without read; with it, through', async () => {
    const denied = harness([]);
    expect((await denied.call('GET', `/v1/conversations/${inP.id}`)).status).toBe(403);
    expect((await denied.call('GET', `/v1/conversations/${inP.id}/messages`)).status).toBe(403);
    expect(denied.asked).toEqual([`read project:${P}`, `read project:${P}`]);
    expect(denied.reached).toEqual([]);

    const allowed = harness([`read project:${P}`]);
    expect((await allowed.call('GET', `/v1/conversations/${inP.id}`)).status).toBe(200);
    expect((await allowed.call('GET', `/v1/conversations/${inP.id}/messages`)).status).toBe(200);
  });

  test('one from before projects is checked on its agent', async () => {
    const { call, asked } = harness([]);
    expect((await call('GET', `/v1/conversations/${legacy.id}`)).status).toBe(403);
    expect(asked).toEqual([`read agent:${AGENT}`]);
  });

  test('the list holds only those the caller may read', async () => {
    const { call } = harness([`read project:${P}`]);
    const body = (await (await call('GET', '/v1/conversations')).json()) as {
      data: { id: string }[];
    };
    expect(body.data.map((c) => c.id)).toEqual([inP.id]);
  });
});

describe('opening or closing one needs execute on its agent', () => {
  test('refused 403 before the binding', async () => {
    const { call, asked, reached } = harness([]);
    const opened = await call('POST', '/v1/conversations', {
      agentId: AGENT,
      agentVersion: '1.0.0',
      projectId: P,
    });
    expect(opened.status).toBe(403);
    expect((await call('POST', `/v1/conversations/${inP.id}/close`)).status).toBe(403);
    expect(asked).toEqual([`execute agent:${AGENT}`, `execute agent:${AGENT}`]);
    expect(reached).toEqual([]);
  });

  test('with execute, through', async () => {
    const { call, reached } = harness([`execute agent:${AGENT}`]);
    await call('POST', '/v1/conversations', {
      agentId: AGENT,
      agentVersion: '1.0.0',
      projectId: P,
    });
    await call('POST', `/v1/conversations/${inP.id}/close`);
    expect(reached).toEqual(['open', 'close']);
  });
});
