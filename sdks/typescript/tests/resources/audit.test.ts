// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { jsonFetch } from '../support/recording-fetch.js';

const API = 'https://api.example.com';

async function listUrl(
  filter: Parameters<ReturnType<typeof createClient>['audit']['authz']['list']>[0],
) {
  const stub = jsonFetch({ data: [], hasMore: false });
  const client = createClient({
    apiUrl: API,
    auth: { kind: 'apiToken', token: 't' },
    fetch: stub.fetch,
  });
  await client.audit.authz.list(filter);
  return stub.calls[0]?.url;
}

describe('audit.authz.list', () => {
  it('asks for newest first with order: desc', async () => {
    expect(await listUrl({ outcome: 'denied', order: 'desc', limit: 50 })).toBe(
      `${API}/v1/audit/authz?limit=50&outcome=denied&order=desc`,
    );
  });

  it('sends no order without one (oldest first)', async () => {
    expect(await listUrl({ limit: 50 })).toBe(`${API}/v1/audit/authz?limit=50`);
  });
});

describe('audit.signIns.list', () => {
  it("one person's sign-ins, newest first", async () => {
    const stub = jsonFetch({ data: [], hasMore: false });
    const client = createClient({
      apiUrl: API,
      auth: { kind: 'apiToken', token: 't' },
      fetch: stub.fetch,
    });
    await client.audit.signIns.list({ userId: 'u-ann', order: 'desc', limit: 20 });
    expect(stub.calls[0]?.url).toBe(`${API}/v1/audit/sign-ins?limit=20&userId=u-ann&order=desc`);
  });

  it('one kind, nothing else', async () => {
    const stub = jsonFetch({ data: [], hasMore: false });
    const client = createClient({
      apiUrl: API,
      auth: { kind: 'apiToken', token: 't' },
      fetch: stub.fetch,
    });
    await client.audit.signIns.list({ kind: 'sign-in-refused' });
    expect(stub.calls[0]?.url).toBe(`${API}/v1/audit/sign-ins?kind=sign-in-refused`);
  });
});
