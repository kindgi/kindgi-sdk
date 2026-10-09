// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { RetentionDomain } from '@kindgi/policy-contract';
import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  RetentionBinding,
  RetentionScheduledInput,
  RetentionScheduledItem,
  RetentionScheduledPage,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

/**
 * `GET /v1/retention/scheduled` paging. `limit` caps the rows per domain;
 * `hasMore` and `nextCursor` come from the runtime's binding, and a
 * binding that leaves `hasMore` out gets it from the page: some domain
 * filled its `limit`.
 */

const tenantId = randomUUID() as TenantId;
const TOKEN = 'retention-token-abc';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
  invokeFlow: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
  resumeRun: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
};

function row(domain: RetentionDomain, n: number): RetentionScheduledItem {
  return {
    domain,
    id: `${domain}-${n}`,
    unregisteredAt: '2026-01-01T00:00:00.000Z',
    purgeAt: '2026-02-01T00:00:00.000Z',
    pastGrace: true,
    policyId: 'pol-1',
    policyVersion: '1',
    graceSeconds: 2_678_400,
  };
}

function makeApp(page: Omit<RetentionScheduledPage, 'domainsMissingAdapter' | 'unpolicedDomains'>) {
  const asked: RetentionScheduledInput[] = [];
  const retention: RetentionBinding = {
    scheduled: async (input) => {
      asked.push(input);
      return { domainsMissingAdapter: [], unpolicedDomains: [], ...page };
    },
    sweep: async () => ({ perDomain: [], totalPurged: 0 }),
  };
  const app = createApp({ ...createStubAppBindings(), resolveToken, runHandler, retention });
  const get = async (query: string) => {
    const res = await app.request(`/v1/retention/scheduled${query}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  return { asked, get };
}

describe('GET /v1/retention/scheduled paging', () => {
  test("passes the binding's `hasMore` and `nextCursor` through", async () => {
    const { get } = makeApp({ data: [row('agent', 1)], hasMore: true, nextCursor: 'c-2' });
    const body = await get('?limit=5');
    expect(body).toMatchObject({ hasMore: true, nextCursor: 'c-2' });
    expect(body.data).toHaveLength(1);
  });

  test('`?cursor=` reaches the binding; no cursor sends none', async () => {
    const { asked, get } = makeApp({ data: [], hasMore: false });
    await get('?limit=5&cursor=c-2');
    await get('?limit=5');
    expect(asked[0]).toMatchObject({ tenantId, limit: 5, cursor: 'c-2' });
    expect(asked[1]).not.toHaveProperty('cursor');
  });

  test('a binding that leaves `hasMore` out: true when some domain filled `limit`', async () => {
    const full = makeApp({ data: [row('agent', 1), row('agent', 2), row('flow', 1)] });
    expect(await full.get('?limit=2')).toMatchObject({ hasMore: true });
    const short = makeApp({ data: [row('agent', 1), row('flow', 1), row('tool', 1)] });
    const body = await short.get('?limit=2');
    expect(body).toMatchObject({ hasMore: false });
    expect(body).not.toHaveProperty('nextCursor');
  });
});
