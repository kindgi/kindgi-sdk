// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * T262: a list page carries its list once. `items`, the deprecated name
 * for `data`, still reads the list, but it isn't an own enumerable
 * property, so `JSON.stringify` (and the CLI's JSON output) and a spread
 * show `data` alone. Before, `items` was a plain copy and every page
 * printed its list twice.
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

  it('still reads items, as the same list as data', () => {
    const page = listPage({ data: ROWS, hasMore: false });
    expect(page.items).toBe(page.data);
    expect(page.items.map((r) => r.id)).toEqual(['a', 'b']);
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
    expect(page.items[0]?.id).toBe('acme.intake');
  });
});
