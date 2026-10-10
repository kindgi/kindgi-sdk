// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A retired flow and its unregistered versions are asked for, never
 * listed by default: `flows.list({ includeRetired })` and
 * `flows.versions.list(id, { includeTombstoned })` send the query only
 * when asked.
 */

import { describe, expect, it } from 'vitest';

import { type KindgiClient, createClient } from '../../src/index.js';
import { recordingFetch } from '../support/recording-fetch.js';

const API = 'https://api.example.com';

async function urlOf(
  call: (client: KindgiClient) => Promise<unknown>,
): Promise<string | undefined> {
  const stub = recordingFetch([
    { status: 200, body: JSON.stringify({ data: [], hasMore: false }) },
  ]);
  const client = createClient({
    apiUrl: API,
    auth: { kind: 'apiToken', token: 't' },
    fetch: stub.fetch,
  });
  await call(client);
  return stub.calls[0]?.url;
}

describe('flows: retired flows and unregistered versions', () => {
  it('list sends includeRetired only when asked', async () => {
    expect(await urlOf((c) => c.flows.list({ includeRetired: true }))).toBe(
      `${API}/v1/flows?includeRetired=true`,
    );
    expect(await urlOf((c) => c.flows.list())).toBe(`${API}/v1/flows`);
  });

  it('versions.list sends includeTombstoned only when asked', async () => {
    expect(
      await urlOf((c) =>
        c.flows.versions.list('acme.intake' as never, { includeTombstoned: true }),
      ),
    ).toBe(`${API}/v1/flows/acme.intake/versions?includeTombstoned=true`);
    expect(await urlOf((c) => c.flows.versions.list('acme.intake' as never))).toBe(
      `${API}/v1/flows/acme.intake/versions`,
    );
  });
});
