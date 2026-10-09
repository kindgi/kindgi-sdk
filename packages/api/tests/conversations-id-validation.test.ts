// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A conversation id in a path that isn't one (a UUID) is a 400, before it
 * reaches the binding, as a run id is (`runs-id-validation.test.ts`):
 * Postgres's uuid cast failed it as a 500 `persistence-error`.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { ConversationBinding } from '@kindgi/agents';
import type { TenantId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'conversations-id-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

/** An app whose conversation binding records every id that reaches it. */
function app() {
  const stubs = createStubAppBindings();
  const reached: string[] = [];
  const conversationBinding = {
    ...stubs.conversationBinding,
    getConversation: async (_t: TenantId, id: string) => {
      reached.push(id);
      return {
        kind: 'err',
        error: { code: 'conversation-not-found', message: `No conversation with id "${id}"` },
      };
    },
  } as unknown as ConversationBinding;
  const built = createApp({
    ...stubs,
    conversationBinding,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
  });
  return { built, reached };
}

async function call(path: string, method = 'GET') {
  const h = app();
  const res = await h.built.request(path, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(method === 'POST' && { 'content-type': 'application/json' }),
    },
    ...(method === 'POST' && { body: '{}' }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown>, ...h };
}

describe("a conversation id that isn't one", () => {
  test.each([
    ['GET', '/v1/conversations/not-a-uuid'],
    ['GET', '/v1/conversations/not-a-uuid/messages'],
    ['POST', '/v1/conversations/not-a-uuid/close'],
  ])('%s %s: 400 bad-input, and the binding never asked', async (method, path) => {
    const answer = await call(path, method);
    expect(answer.status).toBe(400);
    expect(answer.json.error).toMatchObject({
      code: 'bad-input',
      message: '`conversationId` must be a conversation id (a UUID)',
    });
    expect(answer.reached).toEqual([]);
  });

  test('a well-formed id that names no conversation is still a 404', async () => {
    const id = randomUUID();
    const answer = await call(`/v1/conversations/${id}`);
    expect(answer.status).toBe(404);
    expect(answer.json.error).toMatchObject({ code: 'conversation-not-found' });
    expect(answer.reached).toEqual([id]);
  });
});
