// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { jsonFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };

describe('blocks.runsIn', () => {
  it('GETs /v1/blocks/{blockId}/runs-in and answers its rows', async () => {
    const row = {
      projectId: 'prj-prod',
      agentId: 'acme.desk',
      agentVersion: '1.1.0',
      blockVersion: '1.1.0',
      follows: 'pin',
      segment: [{ key: 'region', value: 'eu' }],
    };
    const stub = jsonFetch({ data: [row] });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    expect(await client.blocks.runsIn('acme.tone')).toEqual({ data: [row] });
    expect(stub.calls[0]?.method).toBe('GET');
    expect(new URL(stub.calls[0]?.url ?? '').pathname).toBe('/v1/blocks/acme.tone/runs-in');
  });
});
