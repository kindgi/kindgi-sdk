// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/audit/authz` paging with the filters that live outside the
 * binding's top-level columns (`onBehalfOf`, and `action` / `resource`
 * inside `payload.doc`): pages are full while matches remain, and
 * following `nextCursor` returns every match exactly once.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuditEvent } from '@kindgi/audit-events';
import { createInMemoryAuditEventBinding } from '@kindgi/audit-events-inmemory';
import type { TenantId, Timestamp } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'audit-routes-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

/** 40 decisions; every fourth is a `write` on `agent:acme.drafting` on behalf of an agent. */
function decisions(): AuditEvent[] {
  return Array.from({ length: 40 }, (_, i) => {
    const match = i % 4 === 3;
    return {
      id: `evt-${String(i).padStart(3, '0')}`,
      tenantId,
      kind: 'authz-decision',
      timestamp: new Date(Date.UTC(2026, 8, 30, 12, 0, i)).toISOString() as Timestamp,
      actor: 'user:u-1042',
      ...(match && { onBehalfOf: 'agent:acme.drafting' }),
      outcome: 'allowed',
      payload: {
        v: 1,
        doc: {
          action: match ? 'write' : 'read',
          resource: match ? 'agent:acme.drafting' : 'agent:acme.other',
          reason: 'ok',
        },
      },
    };
  });
}

async function appWith(events: AuditEvent[]): Promise<ReturnType<typeof createApp>> {
  const auditEvents = createInMemoryAuditEventBinding();
  await auditEvents.append(events);
  return createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    auditEvents,
  });
}

interface Page {
  readonly data: readonly { readonly id: string }[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

async function readAll(app: ReturnType<typeof createApp>, query: string): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | undefined;
  do {
    const res = await app.request(
      `/v1/audit/authz?${query}${cursor !== undefined ? `&cursor=${cursor}` : ''}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const page = (await res.json()) as Page;
    pages.push(page);
    cursor = page.nextCursor;
    if (pages.length > 20) throw new Error('paging did not terminate');
  } while (cursor !== undefined);
  return pages;
}

const EXPECTED = ['evt-003', 'evt-007', 'evt-011', 'evt-015', 'evt-019'];
const ALL_MATCHES = Array.from(
  { length: 10 },
  (_, k) => `evt-${String(k * 4 + 3).padStart(3, '0')}`,
);

describe('GET /v1/audit/authz — filters outside the binding columns', () => {
  for (const [name, query] of [
    ['onBehalfOf', 'onBehalfOf=agent:acme.drafting'],
    ['action', 'action=write'],
    ['resource', 'resource=agent:acme.drafting'],
  ] as const) {
    test(`?${name}= fills the page and pages through every match`, async () => {
      const app = await appWith(decisions());
      const pages = await readAll(app, `${query}&limit=5`);

      expect(pages[0]?.data.map((e) => e.id)).toEqual(EXPECTED);
      expect(pages[0]?.hasMore).toBe(true);
      expect(pages.flatMap((p) => p.data.map((e) => e.id))).toEqual(ALL_MATCHES);
      for (const page of pages.slice(0, -1)) expect(page.data).toHaveLength(5);
      expect(pages.at(-1)?.hasMore).toBe(false);
    });
  }
});
