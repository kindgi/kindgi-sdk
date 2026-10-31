// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A retired agent, tool or test set and unregistered versions are asked
 * for, never listed by default: `includeRetired` on the lists and
 * `includeTombstoned` on the versions lists send the query only when set.
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

describe('includeRetired and includeTombstoned', () => {
  it.each([
    [
      'agents.list',
      (c: KindgiClient) => c.agents.list({ includeRetired: true }),
      '/v1/agents?includeRetired=true',
    ],
    ['agents.list (default)', (c: KindgiClient) => c.agents.list(), '/v1/agents'],
    [
      'agents.versions.list',
      (c: KindgiClient) =>
        c.agents.versions.list('acme.drafter' as never, { includeTombstoned: true }),
      '/v1/agents/acme.drafter/versions?includeTombstoned=true',
    ],
    [
      'tools.list',
      (c: KindgiClient) => c.tools.list({ includeRetired: true }),
      '/v1/tools?includeRetired=true',
    ],
    [
      'testSets.list',
      (c: KindgiClient) => c.testSets.list({ includeRetired: true }),
      '/v1/test-sets?includeRetired=true',
    ],
    [
      'testSets.versions.list',
      (c: KindgiClient) => c.testSets.versions.list('acme.cases', { includeTombstoned: true }),
      '/v1/test-sets/acme.cases/versions?includeTombstoned=true',
    ],
    [
      'testSets.versions.list (default)',
      (c: KindgiClient) => c.testSets.versions.list('acme.cases'),
      '/v1/test-sets/acme.cases/versions',
    ],
  ] as const)('%s', async (_, call, path) => {
    expect(await urlOf(call)).toBe(`${API}${path}`);
  });
});
