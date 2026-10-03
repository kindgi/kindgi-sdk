// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };

describe('events not-yet-wired surface — entire /v1/events unrouted', () => {
  it('emit / subscribe / query / subscriptions.* all throw not-yet-wired without hitting the network', async () => {
    const stub = recordingFetch([]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.events.emit({ kind: 'x' } as never)).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'events.emit' },
    });
    await expect(
      client.events.subscribe({ target: { kind: 'stream' } } as never),
    ).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'events.subscribe' },
    });
    await expect(client.events.query()).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'events.query' },
    });
    await expect(client.events.subscriptions.list()).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'events.subscriptions.list' },
    });
    await expect(client.events.subscriptions.get('sub-1' as never)).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'events.subscriptions.get' },
    });
    await expect(client.events.subscriptions.delete('sub-1' as never)).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'events.subscriptions.delete' },
    });
    expect(stub.calls.length).toBe(0);
  });
});

describe('events.stream (no GET /v1/events/subscriptions/{id}/stream wire route)', () => {
  it('rejects the async iterable with not-yet-wired on iteration (no network call)', async () => {
    const stub = recordingFetch([]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const iter = client.events.stream('sub-1' as never)[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'events.stream' },
    });
    expect(stub.calls.length).toBe(0);
  });
});
