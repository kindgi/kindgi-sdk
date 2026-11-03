// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A list page carries its list once, as `data`, beside `hasMore` and
 * `nextCursor`. `items`, the name the client used first, is gone: a page
 * has no such property, so `JSON.stringify` (and the CLI's JSON output)
 * and a spread show the list once.
 */

import { describe, expect, it } from 'vitest';

import { createClient } from '../src/index.js';
import { listPage } from '../src/list-page.js';
import { jsonFetch } from './support/recording-fetch.js';

const ROWS = [{ id: 'a' }, { id: 'b' }];

describe('listPage', () => {
  it('serializes with data once, and no items', () => {
    const page = listPage({ data: ROWS, hasMore: true, nextCursor: 'c-1' });
    expect(JSON.parse(JSON.stringify(page))).toEqual({
      data: ROWS,
      hasMore: true,
      nextCursor: 'c-1',
    });
    expect(Object.keys(page)).toEqual(['data', 'hasMore', 'nextCursor']);
    expect({ ...page }).not.toHaveProperty('items');
  });

  it('has no items: data is the list', () => {
    const page = listPage({ data: ROWS, hasMore: false });
    expect('items' in page).toBe(false);
    expect(page.data.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('a list call answers such a page', async () => {
    const stub = jsonFetch({ data: [{ id: 'acme.intake', version: '1.0.0' }], hasMore: false });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: { kind: 'apiToken', token: 't' },
      fetch: stub.fetch,
    });
    const page = await client.flows.list();
    expect(JSON.stringify(page)).not.toContain('"items"');
    expect('items' in page).toBe(false);
    expect(page.data[0]?.id).toBe('acme.intake');
  });
});
