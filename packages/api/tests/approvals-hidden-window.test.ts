// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/approvals` over a window of approvals the caller can't read.
 * With sealed cursors, a page that holds every approval of the window the
 * caller may read continues after the last one fetched: a window of hidden
 * ones never ends the paging, and the cursor doesn't show where it points.
 * Without a sealer, it continues after the last one shown, as before: a
 * window of hidden approvals then ends with no cursor.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createAeadCursorSealer, createApp } from '../src/index.js';
import type { HitlBinding, RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'approvals-hidden-window';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId, reviewerRole: 'admin' } : null;

let tick = 0;
function approval(projectId: string) {
  tick += 1;
  const createdAt = `2026-10-09T12:00:00.${String(tick).padStart(3, '0')}Z`;
  return {
    id: randomUUID(),
    tenantId,
    projectId,
    subjectKind: 'acme.refund',
    subjectRef: {},
    requiredRole: 'standard',
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
  };
}
type Row = ReturnType<typeof approval>;
const exactOf = (rows: readonly Row[]) =>
  Object.fromEntries(
    rows.map((r) => [r.id, `${r.createdAt.replace('T', ' ').replace('Z', '')}456+00`]),
  );

function decide(action: Action, r: ResourceRef): Decision {
  const allowed = !r.id.includes('hid');
  return {
    allowed,
    reason: 'test',
    evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
  };
}

function harness(window: readonly Row[], sealed: boolean) {
  const seen: Record<string, unknown>[] = [];
  const hitlBinding = {
    listApprovals: async (input: Record<string, unknown>) => {
      seen.push(input);
      return seen.length === 1
        ? {
            kind: 'ok',
            value: { approvals: window, exactCreatedAt: exactOf(window), nextCursor: 'more' },
          }
        : { kind: 'ok', value: { approvals: [] } };
    },
  } as unknown as HitlBinding;
  const app = createApp({
    ...createStubAppBindings(),
    hitlBinding,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    reviewerBinding: { resolveReviewer: async () => 'rev-1' } as never,
    ...(sealed && {
      cursorSealer: createAeadCursorSealer({
        keys: [{ kid: 'k', key: new Uint8Array(32).fill(5) }],
      }),
    }),
    authz: {
      fgaApiUrl: 'http://fga.invalid',
      authzCheckBinding: {
        check: async (_p, action, r) => decide(action, r),
        checkBatch: async (_p, action, rs) => rs.map((r) => decide(action, r)),
      } satisfies AuthzCheckBinding,
    },
  });
  const get = async (path: string) => {
    const res = await app.request(path, { headers: { authorization: `Bearer ${TOKEN}` } });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { get, seen };
}

/** Where the binding was asked to continue: the approval it named. */
const afterOf = (input: Record<string, unknown> | undefined) =>
  (input?.after as { id?: string } | undefined)?.id;

describe('approvals over a window the caller can’t read', () => {
  test('sealed: an empty page still continues, after the last approval fetched', async () => {
    const window = [approval('hid-project'), approval('hid-project')];
    const { get, seen } = harness(window, true);
    const first = await get('/v1/approvals?limit=2');
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual([]);
    expect(first.body.hasMore).toBe(true);
    const cursor = first.body.nextCursor as string;
    expect(cursor.startsWith('k1.')).toBe(true);
    expect(Buffer.from(cursor, 'base64url').toString('latin1')).not.toContain(window[1]?.id);
    const second = await get(`/v1/approvals?limit=2&cursor=${encodeURIComponent(cursor)}`);
    expect(second.status).toBe(200);
    expect(afterOf(seen[1])).toBe(window[1]?.id);
  });

  test('sealed: a page short of the limit continues after the hidden ones behind it', async () => {
    const window = [approval('vis-project'), approval('hid-project'), approval('hid-project')];
    const { get, seen } = harness(window, true);
    const first = await get('/v1/approvals?limit=5');
    expect(first.body.data.map((a: { id: string }) => a.id)).toEqual([window[0]?.id]);
    await get(`/v1/approvals?limit=5&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(afterOf(seen[1])).toBe(window[2]?.id);
  });

  test('sealed: a full page continues after the last approval shown, as before', async () => {
    const window = [approval('vis-project'), approval('vis-project'), approval('hid-project')];
    const { get, seen } = harness(window, true);
    const first = await get('/v1/approvals?limit=1');
    expect(first.body.data.map((a: { id: string }) => a.id)).toEqual([window[0]?.id]);
    await get(`/v1/approvals?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(afterOf(seen[1])).toBe(window[0]?.id);
  });

  test('without a sealer: after the last approval shown, so a hidden window ends with no cursor', async () => {
    const window = [approval('hid-project'), approval('hid-project')];
    const { get } = harness(window, false);
    const first = await get('/v1/approvals?limit=2');
    expect(first.body).toMatchObject({ data: [], hasMore: true });
    expect(first.body.nextCursor).toBeUndefined();
  });
});
