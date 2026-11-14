// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch, noContentFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';
const TENANT = '6f1c2c0e-3b0a-4f1e-9a51-0c1d2e3f4a5b';
const PROJECT = '3f2b8c1e-4a5d-4e6f-9a0b-1c2d3e4f5a6b';
const REPO = { tenantId: TENANT, projectId: PROJECT };
const SINCE = '2026-11-05T00:00:00.000Z';

describe('systemKeptRepos — wire round-trip', () => {
  it('rulings: POST /v1/system/kept-repos/rulings with { ids }, the rulings in order', async () => {
    const answer = {
      rulings: [{ ...REPO, ruling: 'purge', reason: 'erasure', recorded: true }],
    };
    const stub = jsonFetch(answer);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(await client.systemKeptRepos.rulings([REPO])).toEqual(answer);
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(`POST ${API}/v1/system/kept-repos/rulings`);
    expect(JSON.parse(call.body ?? '{}')).toEqual({ ids: [REPO] });
  });

  it('erasures: GET /v1/system/kept-repos/erasures with limit and cursor', async () => {
    const page = { data: [{ ...REPO, since: SINCE }], nextCursor: 'c-2' };
    const stub = jsonFetch(page);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(await client.systemKeptRepos.erasures({ limit: 10, cursor: 'c-1' })).toEqual(page);
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(
      `GET ${API}/v1/system/kept-repos/erasures?limit=10&cursor=c-1`,
    );
  });

  it('reportPurged: POST …/kept-repo/purged with { reason }, answered 204', async () => {
    const stub = noContentFetch();
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.systemKeptRepos.reportPurged({ ...REPO, reason: 'retention' });
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(
      `POST ${API}/v1/system/tenants/${TENANT}/projects/${PROJECT}/kept-repo/purged`,
    );
    expect(JSON.parse(call.body ?? '{}')).toEqual({ reason: 'retention' });
  });

  it('state: GET …/kept-repo', async () => {
    const stub = jsonFetch({ state: 'deleted', since: SINCE });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(await client.systemKeptRepos.state(REPO)).toEqual({ state: 'deleted', since: SINCE });
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(
      `GET ${API}/v1/system/tenants/${TENANT}/projects/${PROJECT}/kept-repo`,
    );
  });

  it('requestErasure: POST …/kept-repo/erasure, a 202 is the request', async () => {
    const stub = jsonFetch({ state: 'erasure-requested', since: SINCE }, { status: 202 });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(await client.systemKeptRepos.requestErasure(REPO, { idempotencyKey: 'k-1' })).toEqual({
      state: 'erasure-requested',
      since: SINCE,
    });
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(
      `POST ${API}/v1/system/tenants/${TENANT}/projects/${PROJECT}/kept-repo/erasure`,
    );
    expect(call.headers['idempotency-key']).toBe('k-1');
  });

  it('requestErasure: a 501 kept-repos-off throws, keeping its code', async () => {
    const stub = errorFetch(501, {
      code: 'kept-repos-off',
      message:
        "This runtime isn't keeping repos for projects without a GitHub repo now, so it can't take an erasure for one.",
    });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await expect(client.systemKeptRepos.requestErasure(REPO)).rejects.toMatchObject({
      error: { code: 'server', serverCode: 'kept-repos-off' },
    });
  });
});
