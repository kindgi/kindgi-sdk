// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What a list call answers: the wire's page, `data`, `hasMore` and
 * `nextCursor`. The calls that answered `items` still do, deprecated.
 * Against an older server that doesn't send `hasMore`, the env and
 * secrets lists derive it from `nextCursor`, and the identity-provider
 * list (never paged) says `false`.
 */

import { describe, expect, it } from 'vitest';

import { type KindgiClient, createClient } from '../../src/index.js';
import { jsonFetch } from '../support/recording-fetch.js';

/** What `call` answers when the server sends `body`. */
async function answer<T>(body: unknown, call: (client: KindgiClient) => Promise<T>): Promise<T> {
  const stub = jsonFetch(body);
  const client = createClient({
    apiUrl: 'https://api.example.com',
    auth: { kind: 'apiToken', token: 't' },
    fetch: stub.fetch,
  });
  return call(client);
}

const TENANT = { kind: 'tenant' } as const;
const ENTRY = { name: 'REGION', value: 'eu' };

describe('a list call that answered items', () => {
  it('answers data, hasMore and nextCursor, with items the same as data', async () => {
    const conversation = { id: 'conv-1' };
    const page = await answer({ data: [conversation], hasMore: true, nextCursor: 'c2' }, (c) =>
      c.conversations.list(),
    );
    expect(page).toEqual({
      data: [conversation],
      hasMore: true,
      nextCursor: 'c2',
      items: [conversation],
    });
  });

  it('leaves nextCursor out on the last page', async () => {
    const page = await answer({ data: [], hasMore: false }, (c) => c.adapters.list());
    expect(page).toEqual({ data: [], hasMore: false, items: [] });
  });
});

describe.each([
  {
    name: 'env.list',
    call: (c: KindgiClient) => c.env.list({ scope: TENANT, envName: 'dev' as never }),
  },
  {
    name: 'secrets.list',
    call: (c: KindgiClient) => c.secrets.list({ scope: TENANT, envName: 'dev' as never }),
  },
  {
    name: 'secrets.listVersions',
    call: (c: KindgiClient) =>
      c.secrets.listVersions({ scope: TENANT, envName: 'dev' as never, name: 'API_KEY' }),
  },
])('$name', ({ call }) => {
  it("passes the server's hasMore through", async () => {
    const page = await answer({ data: [ENTRY], hasMore: false }, call);
    expect(page).toEqual({ data: [ENTRY], hasMore: false });
  });

  it('from an older server, has more when there is a nextCursor', async () => {
    const page = await answer({ data: [ENTRY], nextCursor: 'c2' }, call);
    expect(page).toEqual({ data: [ENTRY], hasMore: true, nextCursor: 'c2' });
  });

  it('from an older server, has no more without a nextCursor', async () => {
    const page = await answer({ data: [ENTRY] }, call);
    expect(page).toEqual({ data: [ENTRY], hasMore: false });
  });
});

describe('auth.providers.list', () => {
  it('from an older server, says there is no more', async () => {
    const page = await answer({ data: [] }, (c) => c.auth.providers.list());
    expect(page).toEqual({ data: [], hasMore: false });
  });
});
