// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { jsonFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };

function client(payload: unknown) {
  const stub = jsonFetch(payload);
  return {
    stub,
    client: createClient({ apiUrl: 'https://api.example.com', auth: AUTH, fetch: stub.fetch }),
  };
}

const CONFLICT = {
  domain: 'provider',
  policyIds: ['acme.keep-providers', 'acme.keep-providers-long'],
  appliedPolicyId: 'acme.keep-providers',
};

describe('retention.scheduled', () => {
  it('GETs /v1/retention/scheduled with the filter', async () => {
    const { stub, client: c } = client({
      data: [
        {
          domain: 'provider',
          id: 'acme-llm',
          unregisteredAt: '2026-10-01T00:00:00Z',
          purgeAt: '2026-10-02T00:00:00Z',
          pastGrace: true,
          policyId: 'acme.keep-providers',
          policyVersion: '1.0.0',
          graceSeconds: 86_400,
        },
      ],
      domainsMissingAdapter: [],
      unpolicedDomains: ['run'],
      conflicts: [CONFLICT],
    });

    const page = await c.retention.scheduled({
      domain: 'provider',
      pastGraceOnly: true,
      limit: 10,
    });

    expect(page.data[0]?.purgeAt).toBe('2026-10-02T00:00:00Z');
    expect(page.conflicts).toEqual([CONFLICT]);
    const url = new URL(stub.calls[0]?.url ?? '');
    expect(stub.calls[0]?.method).toBe('GET');
    expect(url.pathname).toBe('/v1/retention/scheduled');
    expect(url.searchParams.get('domain')).toBe('provider');
    expect(url.searchParams.get('pastGraceOnly')).toBe('true');
    expect(url.searchParams.get('limit')).toBe('10');
  });

  it('sends no query without a filter', async () => {
    const { stub, client: c } = client({
      data: [],
      domainsMissingAdapter: [],
      unpolicedDomains: [],
    });
    await c.retention.scheduled();
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/retention/scheduled');
  });

  it("sends `cursor`, and returns the page's `hasMore` and `nextCursor`", async () => {
    const { stub, client: c } = client({
      data: [],
      domainsMissingAdapter: [],
      unpolicedDomains: [],
      hasMore: true,
      nextCursor: 'c-3',
    });
    const page = await c.retention.scheduled({ cursor: 'c-2' });
    expect(new URL(stub.calls[0]?.url ?? '').searchParams.get('cursor')).toBe('c-2');
    expect(page).toMatchObject({ hasMore: true, nextCursor: 'c-3' });
  });

  it('a runtime that sends no `hasMore`: it says whether a `nextCursor` came', async () => {
    const page = { data: [], domainsMissingAdapter: [], unpolicedDomains: [] };
    expect(await client(page).client.retention.scheduled()).toMatchObject({ hasMore: false });
    expect(await client({ ...page, nextCursor: 'c-2' }).client.retention.scheduled()).toMatchObject(
      { hasMore: true, nextCursor: 'c-2' },
    );
  });
});

describe('retention.sweep', () => {
  it('POSTs /v1/retention/sweep for every domain', async () => {
    const { stub, client: c } = client({
      perDomain: [{ domain: 'provider', purged: 2, remaining: 0, policyId: 'acme.keep-providers' }],
      totalPurged: 2,
    });

    const result = await c.retention.sweep({ maxPerDomain: 100 });

    expect(result.totalPurged).toBe(2);
    expect(stub.calls[0]?.method).toBe('POST');
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/retention/sweep');
    expect(JSON.parse(stub.calls[0]?.body ?? '{}')).toEqual({ maxPerDomain: 100 });
  });

  it('with a domain, POSTs /v1/retention/sweep/{domain}', async () => {
    const { stub, client: c } = client({ perDomain: [], totalPurged: 0 });
    await c.retention.sweep({ domain: 'judge_class' });
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/retention/sweep/judge_class');
    expect(JSON.parse(stub.calls[0]?.body ?? '{}')).toEqual({});
  });
});
