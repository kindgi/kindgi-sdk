// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Who closed a conversation: `POST /v1/conversations/{id}/close` tells the
 * binding the caller, as audit records name an actor, for the record of
 * the close it keeps. One closed already isn't closed again.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { ConversationBinding, ConversationClose } from '@kindgi/agents';
import type { TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const JANE = 'closed-by-jane';
const APP_KEY = 'closed-by-app-key';
const resolveToken: TokenResolver = async (token) => {
  if (token === JANE) return { tenantId, userId: 'u-jane' as UserId };
  if (token === APP_KEY) return { tenantId, serviceAccountId: 'sa-shop' as never };
  return null;
};

const open = {
  id: randomUUID(),
  tenantId,
  agentId: 'acme.desk-agent',
  agentVersion: '1.0.0',
  title: 'Order A-100',
  scope: {},
  openedAt: '2026-10-12T10:00:00.000Z',
  turnCount: 2,
};
const closedOne = { ...open, id: randomUUID(), closedAt: '2026-10-12T11:00:00.000Z' };

function harness() {
  const closing: { id: string; runBinding: unknown; close: ConversationClose | undefined }[] = [];
  const stubs = createStubAppBindings();
  const conversationBinding = {
    ...stubs.conversationBinding,
    getConversation: async (_t: TenantId, id: string) => {
      const found = [open, closedOne].find((c) => c.id === id);
      return found === undefined
        ? { kind: 'err', error: { code: 'conversation-not-found', message: 'x' } }
        : { kind: 'ok', value: found };
    },
    closeConversation: async (
      _t: TenantId,
      id: string,
      runBinding: unknown,
      close?: ConversationClose,
    ) => {
      closing.push({ id, runBinding, close });
      return { kind: 'ok', value: { ...open, closedAt: '2026-10-12T12:00:00.000Z' } };
    },
  } as unknown as ConversationBinding;
  const app = createApp({
    ...stubs,
    conversationBinding,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
  });
  const close = async (id: string, token: string) => {
    const res = await app.request(`/v1/conversations/${id}/close`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { close, closing, runBinding: stubs.kernelBinding.run };
}

describe('closing a conversation tells the binding who closed it', () => {
  test.each([
    ['a person', JANE, 'user:u-jane'],
    ["an app's key", APP_KEY, 'service_account:sa-shop'],
  ])('%s: the caller, as audit records name an actor', async (_who, token, actor) => {
    const h = harness();
    const res = await h.close(open.id, token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.closedAt).toBe('2026-10-12T12:00:00.000Z');
    // Not as its policy: no inactivity window.
    expect(h.closing).toEqual([{ id: open.id, runBinding: h.runBinding, close: { actor } }]);
  });

  test('closed already: answered as it is, and not closed again', async () => {
    const h = harness();
    const res = await h.close(closedOne.id, JANE);
    expect(res.status).toBe(200);
    expect(res.body.closedAt).toBe(closedOne.closedAt);
    expect(h.closing).toEqual([]);
  });
});
