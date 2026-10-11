// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/audit/sign-ins`: the tenant's sign-in history, a tenant admin's
 * to read. Who signed in and out, how, when and from where; what was
 * refused; the emailed links sent or capped.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuditEvent } from '@kindgi/audit-events';
import { createInMemoryAuditEventBinding } from '@kindgi/audit-events-inmemory';
import type { TenantId, Timestamp } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const ADMIN = 'sign-in-audit-admin';
const MEMBER = 'sign-in-audit-member';
const resolveToken: TokenResolver = async (token) =>
  token === ADMIN ? { tenantId, scopes: ['tenant-admin'] } : token === MEMBER ? { tenantId } : null;

const at = (second: number) =>
  new Date(Date.UTC(2026, 9, 9, 12, 0, second)).toISOString() as Timestamp;
const event = (
  id: string,
  second: number,
  kind: string,
  actor: string,
  doc: Record<string, unknown>,
  outcome = 'succeeded',
): AuditEvent => ({
  id,
  tenantId,
  kind,
  timestamp: at(second),
  actor,
  outcome,
  payload: { v: 1, doc },
});

const EVENTS: AuditEvent[] = [
  event('e1', 1, 'signed-in', 'user:u-ann', {
    providerId: 'google',
    clientAddress: '203.0.113.7',
    sessionId: 's-ann-1',
  }),
  event('e2', 2, 'authz-decision', 'user:u-ann', { action: 'read', resource: 'agent:x' }),
  event(
    'e3',
    3,
    'sign-in-refused',
    'user:system',
    { providerId: 'github', reason: 'not-invited', clientAddress: '198.51.100.9' },
    'denied',
  ),
  event('e4', 4, 'sign-in-link-sent', 'user:system', {
    providerId: 'email-link',
    personId: 'u-bo',
    clientAddress: '198.51.100.20',
  }),
  event(
    'e5',
    5,
    'sign-in-link-capped',
    'user:system',
    { providerId: 'email-link', personId: 'u-bo', limit: 'window' },
    'denied',
  ),
  event('e6', 6, 'signed-in', 'user:u-bo', {
    method: 'api-token',
    sessionId: 's-bo-1',
    tokenId: 'tok-1',
  }),
  event('e7', 7, 'run.finished', 'user:u-ann', { runId: 'r-1' }),
  event('e8', 8, 'signed-out', 'user:u-ann', { sessionId: 's-ann-1' }),
];

async function app(): Promise<ReturnType<typeof createApp>> {
  const auditEvents = createInMemoryAuditEventBinding();
  await auditEvents.append(EVENTS);
  return createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    auditEvents,
  });
}

interface SignIn {
  readonly id: string;
  readonly kind: string;
  readonly outcome: string;
  readonly userId?: string;
  readonly method?: string;
  readonly clientAddress?: string;
  readonly reason?: string;
  readonly sessionId?: string;
  readonly byUserId?: string;
}
interface Page {
  readonly data: readonly SignIn[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

const get = async (a: ReturnType<typeof createApp>, query = '', token = ADMIN) =>
  a.request(`/v1/audit/sign-ins${query}`, { headers: { authorization: `Bearer ${token}` } });

describe('GET /v1/audit/sign-ins', () => {
  test('a tenant admin reads the sign-in history: only the sign-in kinds, flattened, oldest first', async () => {
    const res = await get(await app());
    expect(res.status).toBe(200);
    const page = (await res.json()) as Page;
    expect(page.data.map((e) => e.id)).toEqual(['e1', 'e3', 'e4', 'e5', 'e6', 'e8']);
    expect(page.hasMore).toBe(false);
    const byId = Object.fromEntries(page.data.map((e) => [e.id, e]));
    expect(byId.e1).toEqual({
      id: 'e1',
      timestamp: at(1),
      kind: 'signed-in',
      outcome: 'succeeded',
      userId: 'u-ann',
      method: 'google',
      clientAddress: '203.0.113.7',
      sessionId: 's-ann-1',
    });
    // A refusal names no person: who it was isn't known.
    expect(byId.e3).toMatchObject({
      kind: 'sign-in-refused',
      outcome: 'denied',
      reason: 'not-invited',
    });
    expect(byId.e3?.userId).toBeUndefined();
    // An emailed link: for whom, and which limit held.
    expect(byId.e4).toMatchObject({ userId: 'u-bo', method: 'email-link' });
    expect(byId.e5).toMatchObject({ userId: 'u-bo', reason: 'window', outcome: 'denied' });
    expect(byId.e6).toMatchObject({ userId: 'u-bo', method: 'api-token' });
  });

  test("?userId= is one person's own sign-ins and sign-outs", async () => {
    const page = (await (await get(await app(), '?userId=u-ann')).json()) as Page;
    expect(page.data.map((e) => [e.id, e.kind])).toEqual([
      ['e1', 'signed-in'],
      ['e8', 'signed-out'],
    ]);
  });

  test('?kind= one kind; ?order=desc newest first; pages carry on', async () => {
    const a = await app();
    const refused = (await (await get(a, '?kind=sign-in-refused')).json()) as Page;
    expect(refused.data.map((e) => e.id)).toEqual(['e3']);
    const first = (await (await get(a, '?order=desc&limit=4')).json()) as Page;
    expect(first.data.map((e) => e.id)).toEqual(['e8', 'e6', 'e5', 'e4']);
    expect(first.hasMore).toBe(true);
    const rest = (await (
      await get(a, `?order=desc&limit=4&cursor=${first.nextCursor}`)
    ).json()) as Page;
    expect(rest.data.map((e) => e.id)).toEqual(['e3', 'e1']);
    expect(rest.hasMore).toBe(false);
  });

  test('not a tenant admin: 403 permission-denied; a kind that is not a sign-in kind: 400', async () => {
    const a = await app();
    const member = await get(a, '', MEMBER);
    expect(member.status).toBe(403);
    expect(((await member.json()) as { error: { code: string } }).error.code).toBe(
      'permission-denied',
    );
    const bad = await get(a, '?kind=authz-decision');
    expect(bad.status).toBe(400);
    expect((await get(a, '?order=sideways')).status).toBe(400);
  });
});

describe('GET /v1/audit/sign-ins?userId=: the events about the person', () => {
  const revoked = (id: string, second: number, actor: string, person: string): AuditEvent => ({
    ...event(id, second, 'sessions-revoked', actor, { userId: person, revokedCount: 2 }),
    subject: `user:${person}`,
  });
  const HISTORY: AuditEvent[] = [
    event('h1', 1, 'signed-in', 'user:u-cy', { method: 'google', sessionId: 's-cy' }),
    // An admin ended Cy's sessions.
    revoked('h2', 2, 'user:u-admin', 'u-cy'),
    // Dee signed out everywhere herself.
    revoked('h3', 3, 'user:u-dee', 'u-dee'),
    {
      ...event('h4', 4, 'sign-in-link-sent', 'user:system', { personId: 'u-cy' }),
      subject: 'user:u-cy',
    },
  ];

  async function appWith(filtersBySubject: boolean) {
    const inner = createInMemoryAuditEventBinding();
    await inner.append(HISTORY);
    // A binding from before `subject` doesn't say it filters by it.
    const { filtersBySubject: _, ...before } = inner;
    const auditEvents = filtersBySubject ? inner : before;
    return createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler: {} as RunHandlerBinding,
      auditEvents,
    });
  }
  const ids = async (a: ReturnType<typeof createApp>, userId: string) =>
    ((await (await get(a, `?userId=${userId}`)).json()) as Page).data;

  test('an admin who ended a person’s sessions: on the person’s history, saying who; not on the admin’s', async () => {
    const a = await appWith(true);
    const cy = await ids(a, 'u-cy');
    expect(cy.map((e) => e.id)).toEqual(['h1', 'h2', 'h4']);
    expect(cy.find((e) => e.id === 'h2')).toMatchObject({
      kind: 'sessions-revoked',
      userId: 'u-cy',
      byUserId: 'u-admin',
    });
    expect(await ids(a, 'u-admin')).toEqual([]);
  });

  test('a person who signed out everywhere themselves: once, with no byUserId', async () => {
    const dee = await ids(await appWith(true), 'u-dee');
    expect(dee.map((e) => e.id)).toEqual(['h3']);
    expect(dee[0]?.userId).toBe('u-dee');
    expect(dee[0]?.byUserId).toBeUndefined();
  });

  test('a binding that doesn’t filter by subject: the events the person is the actor of, as before', async () => {
    const a = await appWith(false);
    expect((await ids(a, 'u-admin')).map((e) => e.id)).toEqual(['h2']);
    expect((await ids(a, 'u-cy')).map((e) => e.id)).toEqual(['h1']);
  });
});
