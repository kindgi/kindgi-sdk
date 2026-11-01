// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Who opened a conversation (`openedBy`), and "my conversations":
 *   - opening one records the caller's principal, never a body's;
 *   - `GET /v1/conversations?openedBy=me` lists the caller's own, whether
 *     or not the binding filters them itself, and every page of it says so
 *     (`openedBy: 'me'`), an empty one too;
 *   - a caller with no principal opened nothing it could be listed by;
 *   - only `me`.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { ConversationBinding } from '@kindgi/agents';
import type { TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { validateAgainst } from './support/openapi-schema.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const JANE = 'opened-by-jane';
const APP_KEY = 'opened-by-app-key';
const BARE = 'opened-by-bare';
const resolveToken: TokenResolver = async (token) => {
  if (token === JANE) return { tenantId, userId: 'u-jane' as UserId };
  if (token === APP_KEY) return { tenantId, serviceAccountId: 'sa-shop' as never };
  if (token === BARE) return { tenantId };
  return null;
};

const opened = {
  id: randomUUID(),
  tenantId,
  agentId: 'acme.desk-agent',
  agentVersion: '1.0.0',
  title: 'Order A-100',
  scope: {},
  openedBy: 'user:u-jane',
  openedAt: '2026-10-12T10:00:00.000Z',
  turnCount: 0,
};
const byAda = {
  ...opened,
  id: randomUUID(),
  openedBy: 'user:u-ada',
  openedAt: '2026-10-12T09:00:00.000Z',
};
/** Opened by an older runtime: no opener. */
const unknown = { ...opened, id: randomUUID(), openedAt: '2026-10-12T08:00:00.000Z' };
Reflect.deleteProperty(unknown, 'openedBy');

/** A binding that filters by `openedBy` itself (`honours`) or ignores it; a first page has more. */
function harness(honours = true) {
  const openedWith: Record<string, any>[] = [];
  const listedWith: Record<string, any>[] = [];
  const stubs = createStubAppBindings();
  const conversationBinding = {
    ...stubs.conversationBinding,
    openConversation: async (input: Record<string, any>) => {
      openedWith.push(input);
      return {
        kind: 'ok',
        value: { ...opened, ...(input.openedBy !== undefined && { openedBy: input.openedBy }) },
      };
    },
    listConversationsPage: async (input: Record<string, any>) => {
      listedWith.push(input);
      let rows: Record<string, any>[] = [opened, byAda, unknown];
      if (honours && input.openedBy !== undefined) {
        rows = rows.filter((row) => row.openedBy === input.openedBy);
      }
      return { kind: 'ok', value: { data: rows, hasMore: input.before === undefined } };
    },
  } as unknown as ConversationBinding;
  const app = createApp({
    ...stubs,
    conversationBinding,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
  });
  const call = async (path: string, token: string, body?: unknown) => {
    const res = await app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { call, openedWith, listedWith };
}

const OPEN = {
  agentId: 'acme.desk-agent',
  agentVersion: '1.0.0',
  title: 'Order A-100',
  // Never read: who opened it is the caller.
  openedBy: 'user:u-someone-else',
};

describe('opening a conversation records who opened it', () => {
  test.each([
    ['a person', JANE, 'user:u-jane'],
    ["an app's key", APP_KEY, 'service_account:sa-shop'],
  ])('%s: the caller, never the body', async (_who, token, expected) => {
    const h = harness();
    const res = await h.call('/v1/conversations', token, OPEN);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(h.openedWith[0]?.openedBy).toBe(expected);
    expect(res.body.openedBy).toBe(expected);
    expect(validateAgainst('Conversation', res.body)).toEqual([]);
  });

  test('a caller with no principal: no opener', async () => {
    const h = harness();
    const res = await h.call('/v1/conversations', BARE, OPEN);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(h.openedWith[0]).not.toHaveProperty('openedBy');
  });
});

describe('my conversations (?openedBy=me)', () => {
  test.each([true, false])(
    "only the caller's own, whether the binding filters (%s) or the route does",
    async (honours) => {
      const h = harness(honours);
      const res = await h.call('/v1/conversations?openedBy=me', JANE);
      expect(res.status).toBe(200);
      expect(h.listedWith[0]?.openedBy).toBe('user:u-jane');
      expect(res.body.data.map((c: { id: string }) => c.id)).toEqual([opened.id]);
      expect(res.body.openedBy).toBe('me');
      expect(validateAgainst('ConversationCollectionPage', res.body)).toEqual([]);
    },
  );

  test('every page says it filtered: a later page, and an empty one', async () => {
    const h = harness(false);
    const first = await h.call('/v1/conversations?openedBy=me', JANE);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const later = await h.call(
      `/v1/conversations?openedBy=me&cursor=${encodeURIComponent(first.body.nextCursor)}`,
      JANE,
    );
    // An app's key opened none of them: the route keeps none.
    const none = await h.call('/v1/conversations?openedBy=me', APP_KEY);
    expect(h.listedWith[1]?.before).toBeDefined();
    expect(none.body.data).toEqual([]);
    for (const { status, body } of [later, none]) {
      expect(status, JSON.stringify(body)).toBe(200);
      expect(body.openedBy).toBe('me');
      expect(validateAgainst('ConversationCollectionPage', body)).toEqual([]);
    }
  });

  test("without it, nothing is narrowed, and the page doesn't say it was", async () => {
    const h = harness(false);
    const res = await h.call('/v1/conversations', JANE);
    expect(h.listedWith[0]).not.toHaveProperty('openedBy');
    expect(res.body.data).toHaveLength(3);
    expect(res.body).not.toHaveProperty('openedBy');
  });

  test('a caller with no principal opened nothing it could be listed by', async () => {
    const h = harness();
    const res = await h.call('/v1/conversations?openedBy=me', BARE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], hasMore: false, openedBy: 'me' });
    expect(h.listedWith).toEqual([]);
  });

  test('only `me`', async () => {
    const res = await harness().call('/v1/conversations?openedBy=user:u-ada', JANE);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad-input');
  });
});

describe("a conversation's title", () => {
  const { title: _title, ...untitled } = OPEN;

  test('201 code points are refused, and nothing is opened', async () => {
    const h = harness();
    const res = await h.call('/v1/conversations', JANE, { ...OPEN, title: 'x'.repeat(201) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'bad-input',
      message: '`title` must be a string of at most 200 characters when supplied',
    });
    expect(h.openedWith).toEqual([]);
  });

  test('200 code points outside the BMP, 400 UTF-16 units, are taken', async () => {
    const h = harness();
    const title = String.fromCodePoint(0x1f600).repeat(200);
    expect((await h.call('/v1/conversations', JANE, { ...OPEN, title })).status).toBe(201);
    expect(h.openedWith[0]?.title).toBe(title);
  });

  test.each([
    ['blank', { ...untitled, title: '   ' }],
    ['absent', untitled],
  ])('a %s one is "Untitled conversation"', async (_what, body) => {
    const h = harness();
    expect((await h.call('/v1/conversations', JANE, body)).status).toBe(201);
    expect(h.openedWith[0]?.title).toBe('Untitled conversation');
  });
});
