// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { jsonFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';

describe('license — wire round-trip', () => {
  it('get: GET /v1/license, the status as the runtime reports it', async () => {
    const status = {
      mode: 'licensed',
      name: 'acme.example',
      use: 'non-production',
      expiresAt: '2026-11-20T00:00:00.000Z',
      daysLeft: 12,
      standing: 'expiring',
      renew:
        'from this deployment (kindgi license renew …), or sign in at https://access.kindgi.com',
    };
    const stub = jsonFetch(status);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(await client.license.get()).toEqual(status);
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(`GET ${API}/v1/license`);
  });
});
