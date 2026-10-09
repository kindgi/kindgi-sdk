// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `/v1/memory/erasures`: the wire, the validation and the gate (a tenant
 * admin only, for every selector) over a recording binding.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  MemoryErasure,
  MemoryErasureBinding,
  MemoryErasureLedgerEntry,
  MemoryErasureSelector,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const ADMIN = 'token-admin';
const MEMBER = 'token-member';
const resolveToken: TokenResolver = async (token) => {
  if (token === ADMIN) return { tenantId, userId: 'admin-1' as UserId };
  if (token === MEMBER) return { tenantId, userId: 'member-1' as UserId };
  return null;
};

function decision(principal: unknown, action: Action, resource: ResourceRef): Decision {
  const who = (principal as { actor: { id: string } }).actor.id;
  const allowed = who === 'admin-1' && action === 'admin' && resource.type === 'tenant';
  return {
    allowed,
    reason: allowed ? 'test: tenant admin' : 'test: not granted',
    evidence: {
      action,
      relation: '',
      resource: `${resource.type}:${resource.id}`,
      actorSubject: '',
    },
  };
}

const authz: AuthzCheckBinding = {
  check: async (principal, action, resource) => decision(principal, action, resource),
  checkBatch: async (principal, action, resources) =>
    resources.map((resource) => decision(principal, action, resource)),
};

const erasure = (over: Partial<MemoryErasure> = {}): MemoryErasure => ({
  id: randomUUID(),
  selectorKind: 'participant',
  selector: { subject: { kind: 'participant', id: 'end-7' } },
  status: 'pending',
  phase: 'seed',
  requestedBy: 'user:admin-1',
  matchable: true,
  counts: {},
  attempts: 0,
  createdAt: '2026-10-07T00:00:00.000Z',
  ...over,
});

const entry = (over: Partial<MemoryErasureLedgerEntry> = {}): MemoryErasureLedgerEntry => ({
  id: randomUUID(),
  selectorKind: 'participant',
  selectorHmac: 'a'.repeat(64),
  keyId: 'v1.0011223344556677',
  requestedBy: 'user:admin-1',
  status: 'completed',
  createdAt: '2026-10-07T00:00:00.000Z',
  completedAt: '2026-10-07T00:01:00.000Z',
  ...over,
});

function harness(behaviour: { refuse?: boolean; unmatchable?: boolean } = {}) {
  const created: { selector: MemoryErasureSelector; requestedBy: string }[] = [];
  const replayed: MemoryErasureLedgerEntry[][] = [];
  const resumed: { id: string; force: boolean }[] = [];
  const known = erasure({ status: 'completed', phase: 'done' });
  const binding: MemoryErasureBinding = {
    async create({ selector, requestedBy }) {
      created.push({ selector, requestedBy });
      if (behaviour.refuse === true) {
        return {
          kind: 'refused',
          refusal: { code: 'legal-hold', message: 'Held facts', factIds: ['f-1'] },
        };
      }
      return {
        kind: 'created',
        erasure: erasure({ selector }),
        warnings:
          behaviour.unmatchable === true
            ? [{ code: 'erasure-unmatchable', message: 'no key' }]
            : [],
      };
    },
    async get(_t, id) {
      return id === known.id ? known : undefined;
    },
    async list(_t, page) {
      if (page.cursor === 'bad') return undefined;
      return page.cursor === undefined ? { data: [known], nextCursor: 'next-1' } : { data: [] };
    },
    async exportLedger() {
      return [entry()];
    },
    async resume(_t, id, options) {
      resumed.push({ id, force: options.force === true });
      return id === known.id
        ? { ...known, ...(options.force === true && { forced: true as const }) }
        : undefined;
    },
    async replay(_t, entries) {
      replayed.push([...entries]);
      return { replayed: entries.map((e) => e.id), restored: [], unmatched: [] };
    },
  };
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    memoryErasures: binding,
    authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding: authz },
  });
  const call = async (method: string, path: string, body?: unknown, token = ADMIN) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { call, created, replayed, resumed, known };
}

describe('POST /v1/memory/erasures', () => {
  test('starts an erasure (202), as the caller', async () => {
    const h = harness();
    const res = await h.call('POST', '/v1/memory/erasures', {
      subject: { kind: 'participant', id: 'end-7' },
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'pending', selectorKind: 'participant' });
    expect(res.body.warnings).toBeUndefined();
    expect(h.created).toEqual([
      { selector: { subject: { kind: 'participant', id: 'end-7' } }, requestedBy: 'user:admin-1' },
    ]);
  });

  test("says when it can't be replayed after a restore", async () => {
    const res = await harness({ unmatchable: true }).call('POST', '/v1/memory/erasures', {
      factId: 'f-1',
    });
    expect(res.status).toBe(202);
    expect(res.body.warnings).toEqual([{ code: 'erasure-unmatchable', message: 'no key' }]);
  });

  test('409 legal-hold names the held facts', async () => {
    const res = await harness({ refuse: true }).call('POST', '/v1/memory/erasures', {
      conversationId: 'c-1',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'legal-hold', details: { factIds: ['f-1'] } });
  });

  test.each([
    [{}, 'Name exactly one'],
    [{ factId: 'f', conversationId: 'c' }, 'Name exactly one'],
    [{ factId: '' }, '`factId`'],
    [{ subject: { kind: 'tenant', id: 'x' } }, '`subject.kind`'],
    [{ subject: { kind: 'participant' } }, '`subject.id`'],
    // Erasing a Kindgi user (an employee) isn't offered.
    [{ subject: { kind: 'user', id: 'u-1' } }, "Erasing a Kindgi user isn't offered"],
    [{ factId: 'f', note: 'x' }, 'Unknown field `note`'],
  ])('400 for %j', async (body, message) => {
    const res = await harness().call('POST', '/v1/memory/erasures', body);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain(message);
  });

  test('403 for anyone but a tenant admin, whatever the selector', async () => {
    const h = harness();
    for (const body of [
      { factId: 'f' },
      { conversationId: 'c' },
      { subject: { kind: 'participant', id: 'end-7' } },
    ]) {
      expect((await h.call('POST', '/v1/memory/erasures', body, MEMBER)).status).toBe(403);
    }
    expect((await h.call('GET', '/v1/memory/erasures', undefined, MEMBER)).status).toBe(403);
    expect((await h.call('GET', '/v1/memory/erasures/export', undefined, MEMBER)).status).toBe(403);
    expect(h.created).toEqual([]);
  });
});

describe('reading erasures', () => {
  test('one by id; 404 for an unknown or malformed one', async () => {
    const h = harness();
    expect((await h.call('GET', `/v1/memory/erasures/${h.known.id}`)).body).toMatchObject({
      id: h.known.id,
      status: 'completed',
    });
    expect((await h.call('GET', `/v1/memory/erasures/${randomUUID()}`)).status).toBe(404);
    expect((await h.call('GET', '/v1/memory/erasures/not-a-uuid')).status).toBe(404);
  });

  test('a page, with hasMore; a cursor it never issued is 400', async () => {
    const h = harness();
    const first = await h.call('GET', '/v1/memory/erasures?limit=10');
    expect(first.body).toMatchObject({ hasMore: true, nextCursor: 'next-1' });
    expect((await h.call('GET', '/v1/memory/erasures?cursor=next-1')).body).toEqual({
      data: [],
      hasMore: false,
    });
    expect((await h.call('GET', '/v1/memory/erasures?cursor=bad')).status).toBe(400);
  });

  test('the export: the whole ledger', async () => {
    const res = await harness().call('GET', '/v1/memory/erasures/export');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ selectorKind: 'participant', status: 'completed' });
  });
});

describe('POST /v1/memory/erasures/replay', () => {
  test('takes the exported ledger back', async () => {
    const h = harness();
    const { selectorHmac: _h, keyId: _k, ...unhashed } = entry();
    const ledger = [entry(), unhashed];
    const res = await h.call('POST', '/v1/memory/erasures/replay', {
      erasures: JSON.parse(JSON.stringify(ledger)),
    });
    expect(res.status).toBe(200);
    expect(res.body.replayed).toEqual(ledger.map((e) => e.id));
    expect(h.replayed[0]?.[1]).not.toHaveProperty('selectorHmac');
  });

  test.each([
    [{}, '`{erasures: [...]}`'],
    [{ erasures: [{ ...entry(), id: 'x' }] }, 'erasures[0].id'],
    [{ erasures: [{ ...entry(), selectorKind: 'run' }] }, 'erasures[0].selectorKind'],
    [{ erasures: [{ ...entry(), selectorHmac: 'abc' }] }, 'erasures[0].selectorHmac'],
    [{ erasures: [{ ...entry(), status: 'done' }] }, 'erasures[0].status'],
    [{ erasures: [{ ...entry(), createdAt: 'yesterday' }] }, 'erasures[0].createdAt'],
  ])('400 for %j', async (body, message) => {
    const res = await harness().call('POST', '/v1/memory/erasures/replay', body);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain(message);
  });
});

describe('POST /v1/memory/erasures/{erasureId}/resume', () => {
  test('tries again now; `force` stops the wait; 404 for an unknown one; 400 for a bad body', async () => {
    const h = harness();
    const plain = await h.call('POST', `/v1/memory/erasures/${h.known.id}/resume`, {});
    expect(plain.status).toBe(200);
    expect(plain.body.forced).toBeUndefined();
    const forced = await h.call('POST', `/v1/memory/erasures/${h.known.id}/resume`, {
      force: true,
    });
    expect(forced.body.forced).toBe(true);
    expect(h.resumed).toEqual([
      { id: h.known.id, force: false },
      { id: h.known.id, force: true },
    ]);
    expect((await h.call('POST', `/v1/memory/erasures/${randomUUID()}/resume`, {})).status).toBe(
      404,
    );
    expect(
      (await h.call('POST', `/v1/memory/erasures/${h.known.id}/resume`, { force: 'yes' })).status,
    ).toBe(400);
    expect(
      (await h.call('POST', `/v1/memory/erasures/${h.known.id}/resume`, { force: true }, MEMBER))
        .status,
    ).toBe(403);
  });
});
