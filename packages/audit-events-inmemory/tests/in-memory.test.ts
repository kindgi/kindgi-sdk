// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { AuditEvent } from '@kindgi/audit-events';
import type { TenantId, Timestamp } from '@kindgi/types';

import { createInMemoryAuditEventBinding } from '../src/index.js';

const TENANT = '00000000-0000-0000-0000-000000000001' as TenantId;
const TENANT_B = '00000000-0000-0000-0000-000000000002' as TenantId;

function baseEvent(overrides: Partial<AuditEvent> & Pick<AuditEvent, 'id'>): AuditEvent {
  return {
    tenantId: TENANT,
    kind: 'authz-decision',
    timestamp: '2026-09-24T00:00:00.000Z' as Timestamp,
    actor: 'user:alice',
    payload: { v: 1, doc: {} },
    ...overrides,
  };
}

describe('createInMemoryAuditEventBinding — append + query', () => {
  test('appends events and returns them cursor-paginated', async () => {
    const b = createInMemoryAuditEventBinding();
    await b.append([
      baseEvent({ id: 'e-1' }),
      baseEvent({ id: 'e-2', timestamp: '2026-09-24T00:00:01.000Z' as Timestamp }),
    ]);
    const page = await b.query({ tenantId: TENANT, limit: 10 });
    expect(page.kind).toBe('ok');
    if (page.kind !== 'ok') return;
    expect(page.value.data.map((e) => e.id)).toEqual(['e-1', 'e-2']);
  });

  test('idempotent on duplicate id within tenant', async () => {
    const b = createInMemoryAuditEventBinding();
    await b.append([baseEvent({ id: 'dup' })]);
    await b.append([baseEvent({ id: 'dup', actor: 'user:other' })]);
    const page = await b.query({ tenantId: TENANT });
    if (page.kind !== 'ok') throw new Error('query failed');
    expect(page.value.data).toHaveLength(1);
    // First-write wins — idempotent semantics.
    expect(page.value.data[0]?.actor).toBe('user:alice');
  });

  test('filters by kind + outcome + id', async () => {
    const b = createInMemoryAuditEventBinding();
    await b.append([
      baseEvent({ id: 'a', kind: 'authz-decision', outcome: 'allowed' }),
      baseEvent({ id: 'b', kind: 'authz-decision', outcome: 'denied' }),
      baseEvent({ id: 'c', kind: 'run-outcome', outcome: 'succeeded' }),
    ]);
    const denies = await b.query({
      tenantId: TENANT,
      filter: { kind: 'authz-decision', outcome: 'denied' },
    });
    if (denies.kind !== 'ok') throw new Error('query failed');
    expect(denies.value.data.map((e) => e.id)).toEqual(['b']);

    const byId = await b.query({ tenantId: TENANT, filter: { id: 'c' } });
    if (byId.kind !== 'ok') throw new Error('query failed');
    expect(byId.value.data.map((e) => e.id)).toEqual(['c']);
  });

  test('filters by onBehalfOf', async () => {
    const b = createInMemoryAuditEventBinding();
    await b.append([
      baseEvent({ id: 'a', onBehalfOf: 'agent:acme.drafting' }),
      baseEvent({ id: 'b' }),
      baseEvent({ id: 'c', onBehalfOf: 'agent:acme.other' }),
    ]);
    const page = await b.query({ tenantId: TENANT, filter: { onBehalfOf: 'agent:acme.drafting' } });
    if (page.kind !== 'ok') throw new Error('query failed');
    expect(page.value.data.map((e) => e.id)).toEqual(['a']);
  });

  test('filters by payloadDoc fields (every entry must match)', async () => {
    const b = createInMemoryAuditEventBinding();
    await b.append([
      baseEvent({ id: 'a', payload: { v: 1, doc: { action: 'write', resource: 'agent:x' } } }),
      baseEvent({ id: 'b', payload: { v: 1, doc: { action: 'write', resource: 'agent:y' } } }),
      baseEvent({ id: 'c', payload: { v: 1, doc: { action: 'read', resource: 'agent:x' } } }),
      baseEvent({ id: 'd', payload: { v: 1 } }),
    ]);
    const writes = await b.query({ tenantId: TENANT, filter: { payloadDoc: { action: 'write' } } });
    if (writes.kind !== 'ok') throw new Error('query failed');
    expect(writes.value.data.map((e) => e.id)).toEqual(['a', 'b']);

    const both = await b.query({
      tenantId: TENANT,
      filter: { payloadDoc: { action: 'write', resource: 'agent:x' } },
    });
    if (both.kind !== 'ok') throw new Error('query failed');
    expect(both.value.data.map((e) => e.id)).toEqual(['a']);

    const empty = await b.query({ tenantId: TENANT, filter: { payloadDoc: {} } });
    if (empty.kind !== 'ok') throw new Error('query failed');
    expect(empty.value.data).toHaveLength(4);
  });

  test('pages over filtered events only: full pages, exact cursors', async () => {
    const b = createInMemoryAuditEventBinding();
    await b.append(
      Array.from({ length: 12 }, (_, i) =>
        baseEvent({
          id: `e-${String(i).padStart(2, '0')}`,
          payload: { v: 1, doc: { action: i % 3 === 0 ? 'write' : 'read' } },
        }),
      ),
    );
    const first = await b.query({
      tenantId: TENANT,
      filter: { payloadDoc: { action: 'write' } },
      limit: 2,
    });
    if (first.kind !== 'ok') throw new Error('query failed');
    expect(first.value.data.map((e) => e.id)).toEqual(['e-00', 'e-03']);
    expect(first.value.nextCursor).toBeDefined();
    const second = await b.query({
      tenantId: TENANT,
      filter: { payloadDoc: { action: 'write' } },
      limit: 2,
      ...(first.value.nextCursor !== undefined && { cursor: first.value.nextCursor }),
    });
    if (second.kind !== 'ok') throw new Error('query failed');
    expect(second.value.data.map((e) => e.id)).toEqual(['e-06', 'e-09']);
    expect(second.value.nextCursor).toBeUndefined();
  });

  test('cross-tenant isolation', async () => {
    const b = createInMemoryAuditEventBinding();
    await b.append([
      baseEvent({ id: 't1', tenantId: TENANT }),
      baseEvent({ id: 't2', tenantId: TENANT_B }),
    ]);
    const a = await b.query({ tenantId: TENANT });
    const bb = await b.query({ tenantId: TENANT_B });
    if (a.kind !== 'ok' || bb.kind !== 'ok') throw new Error('query failed');
    expect(a.value.data.map((e) => e.id)).toEqual(['t1']);
    expect(bb.value.data.map((e) => e.id)).toEqual(['t2']);
  });

  test('purge removes rows older than cutoff for the given kind', async () => {
    const b = createInMemoryAuditEventBinding();
    await b.append([
      baseEvent({ id: 'old', timestamp: '2026-01-01T00:00:00.000Z' as Timestamp }),
      baseEvent({ id: 'new', timestamp: '2026-09-24T00:00:00.000Z' as Timestamp }),
    ]);
    const purged = await b.purge({
      tenantId: TENANT,
      kind: 'authz-decision',
      olderThan: '2026-06-01T00:00:00.000Z',
    });
    if (purged.kind !== 'ok') throw new Error('purge failed');
    expect(purged.value.deleted).toBe(1);
    const page = await b.query({ tenantId: TENANT });
    if (page.kind !== 'ok') throw new Error('query failed');
    expect(page.value.data.map((e) => e.id)).toEqual(['new']);
  });

  test('rejects empty event id at append boundary', async () => {
    const b = createInMemoryAuditEventBinding();
    const r = await b.append([baseEvent({ id: '' })]);
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    expect(r.error.code).toBe('invalid-event');
  });
});

describe('createInMemoryAuditEventBinding — order', () => {
  /** Five events; `b` and `c` share a timestamp. */
  async function binding() {
    const b = createInMemoryAuditEventBinding();
    const at = (s: number) => `2026-09-24T00:00:0${s}.000Z` as Timestamp;
    await b.append([
      baseEvent({ id: 'a', timestamp: at(1) }),
      baseEvent({ id: 'b', timestamp: at(2) }),
      baseEvent({ id: 'c', timestamp: at(2) }),
      baseEvent({ id: 'd', timestamp: at(3) }),
      baseEvent({ id: 'e', timestamp: at(4) }),
    ]);
    return b;
  }

  /** Every page of `order`, two at a time, following `nextCursor`. */
  async function pages(order?: 'asc' | 'desc'): Promise<string[][]> {
    const b = await binding();
    const out: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = await b.query({
        tenantId: TENANT,
        limit: 2,
        ...(order !== undefined && { order }),
        ...(cursor !== undefined && { cursor }),
      });
      if (page.kind !== 'ok') throw new Error('query failed');
      out.push(page.value.data.map((e) => e.id));
      cursor = page.value.nextCursor;
    } while (cursor !== undefined);
    return out;
  }

  test('oldest first by default, ties by id', async () => {
    expect(await pages()).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  test("'desc': newest first, and the cursor continues newest to oldest", async () => {
    expect(await pages('desc')).toEqual([['e', 'd'], ['c', 'b'], ['a']]);
  });
});
